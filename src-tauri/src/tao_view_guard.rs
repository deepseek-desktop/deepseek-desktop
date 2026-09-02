//! Works around an upstream null dereference in Tao's macOS view handlers.
//!
//! Every `TaoView` handler starts by reading the `taoState` instance variable and
//! immediately treating it as a live `ViewState`:
//!
//! ```text
//! let state_ptr: *mut c_void = *this.get_ivar("taoState");
//! let state = &mut *(state_ptr as *mut ViewState);
//! ... state.ns_window.load()          // objc_loadWeakRetained
//! ```
//!
//! `ns_window` is the first field, so a null ivar makes that call read address
//! zero and the process dies with `EXC_BAD_ACCESS` at `0x0`. AppKit delivers
//! mouse-tracking and layout callbacks to views whose state is not (or no longer)
//! attached — closing a native menu, moving between menu titles and resizing the
//! window all reproduce it — so the crash is reachable from ordinary use.
//!
//! The guard replaces those handlers with trampolines that drop the callback when
//! `taoState` is null and forward everything else to Tao untouched. It only
//! Only pure event-delivery handlers are guarded. Dropping a mouse event for a
//! view that has no state is invisible, whereas `viewDidMoveToWindow` and
//! `resetCursorRects` rebuild the tracking rect and cursor rects AppKit relies on
//! — skipping those leaves stale tracking registrations behind and AppKit later
//! aborts trying to weakly reference a deallocating view.

use std::ffi::{c_char, c_void};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicPtr, Ordering};

use crate::error::{DesktopError, DesktopResult};

type ArgumentHandler = unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void);

unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn class_getInstanceMethod(class: *const c_void, selector: *const c_void) -> *mut c_void;
    fn method_getImplementation(method: *const c_void) -> *mut c_void;
    fn method_setImplementation(method: *mut c_void, implementation: *const c_void) -> *mut c_void;
    fn object_getInstanceVariable(
        object: *mut c_void,
        name: *const c_char,
        value: *mut *mut c_void,
    ) -> *mut c_void;
}

/// True only when Tao has a live `ViewState` attached to this view.
fn view_state_is_attached(view: *mut c_void) -> bool {
    if view.is_null() {
        return false;
    }
    let mut state = std::ptr::null_mut();
    let ivar = unsafe { object_getInstanceVariable(view, c"taoState".as_ptr(), &mut state) };
    !ivar.is_null() && !state.is_null()
}

macro_rules! guarded_handler {
    ($original:ident, $trampoline:ident, ($($argument:ident: *mut c_void),*), $signature:ty) => {
        static $original: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

        unsafe extern "C" fn $trampoline(
            view: *mut c_void,
            selector: *const c_void,
            $($argument: *mut c_void),*
        ) {
            if !view_state_is_attached(view) {
                return;
            }
            let original = $original.load(Ordering::Acquire);
            if original.is_null() {
                return;
            }
            let original: $signature = unsafe { std::mem::transmute(original) };
            unsafe { original(view, selector $(, $argument)*) };
        }
    };
}

guarded_handler!(ORIGINAL_MOUSE_MOVED, guarded_mouse_moved, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_MOUSE_ENTERED, guarded_mouse_entered, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_MOUSE_EXITED, guarded_mouse_exited, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_MOUSE_DRAGGED, guarded_mouse_dragged, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_SCROLL_WHEEL, guarded_scroll_wheel, (event: *mut c_void), ArgumentHandler);

struct GuardedSelector {
    name: &'static std::ffi::CStr,
    original: &'static AtomicPtr<c_void>,
    trampoline: *const c_void,
}

// Raw function pointers are only read, never mutated, after this table is built.
unsafe impl Sync for GuardedSelector {}

static GUARDED_SELECTORS: &[GuardedSelector] = &[
    GuardedSelector {
        name: c"mouseMoved:",
        original: &ORIGINAL_MOUSE_MOVED,
        trampoline: guarded_mouse_moved as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"mouseEntered:",
        original: &ORIGINAL_MOUSE_ENTERED,
        trampoline: guarded_mouse_entered as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"mouseExited:",
        original: &ORIGINAL_MOUSE_EXITED,
        trampoline: guarded_mouse_exited as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"mouseDragged:",
        original: &ORIGINAL_MOUSE_DRAGGED,
        trampoline: guarded_mouse_dragged as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"scrollWheel:",
        original: &ORIGINAL_SCROLL_WHEEL,
        trampoline: guarded_scroll_wheel as *const () as *const c_void,
    },
];

static INSTALLED: OnceLock<Result<(), String>> = OnceLock::new();

/// Installs the guard once. Tao registers `TaoView` while the first window is
/// created, so this has to run after the window exists and before the event loop
/// starts delivering tracking callbacks.
pub fn install() -> DesktopResult<()> {
    INSTALLED
        .get_or_init(|| {
            let class = unsafe { objc_getClass(c"TaoView".as_ptr()) };
            if class.is_null() {
                return Err("TaoView is unavailable".to_owned());
            }
            for guarded in GUARDED_SELECTORS {
                let selector = unsafe { sel_registerName(guarded.name.as_ptr()) };
                let method = unsafe { class_getInstanceMethod(class, selector) };
                if method.is_null() {
                    return Err(format!(
                        "TaoView {} is unavailable",
                        guarded.name.to_string_lossy()
                    ));
                }
                let original = unsafe { method_getImplementation(method) };
                if original.is_null() {
                    return Err(format!(
                        "TaoView {} has no implementation",
                        guarded.name.to_string_lossy()
                    ));
                }
                guarded.original.store(original, Ordering::Release);
                let previous = unsafe { method_setImplementation(method, guarded.trampoline) };
                if previous != original {
                    return Err(format!(
                        "TaoView {} changed during initialization",
                        guarded.name.to_string_lossy()
                    ));
                }
            }
            Ok(())
        })
        .as_ref()
        .map(|_| ())
        .map_err(|error| DesktopError::Other(error.clone()))
}

#[cfg(test)]
mod tests {
    use super::{GUARDED_SELECTORS, view_state_is_attached};

    #[test]
    fn a_view_without_attached_state_is_never_forwarded() {
        assert!(!view_state_is_attached(std::ptr::null_mut()));
    }

    #[test]
    fn guards_only_pure_event_delivery_handlers() {
        let names: Vec<String> = GUARDED_SELECTORS
            .iter()
            .map(|guarded| guarded.name.to_string_lossy().into_owned())
            .collect();
        for expected in [
            "mouseMoved:",
            "mouseEntered:",
            "mouseExited:",
            "mouseDragged:",
            "scrollWheel:",
        ] {
            assert!(names.iter().any(|name| name == expected), "{expected}");
        }
        // These rebuild the tracking rect and cursor rects AppKit depends on;
        // dropping them strands stale registrations and AppKit later aborts on a
        // weak reference to a deallocating view.
        for bookkeeping in ["viewDidMoveToWindow", "resetCursorRects", "frameDidChange:"] {
            assert!(
                !names.iter().any(|name| name == bookkeeping),
                "{bookkeeping} must keep running"
            );
        }
        // drawRect: passes an NSRect by value and cannot share these trampolines.
        assert!(!names.iter().any(|name| name == "drawRect:"));
    }
}
