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
//! A missing state pointer, or a pointer whose `ViewState` has already been freed
//! by `TaoView.dealloc`, makes the weak-window load read invalid memory and the
//! process dies with `EXC_BAD_ACCESS`. AppKit can still deliver delayed input while
//! a view is being torn down — closing a native menu, changing fullscreen state and
//! resizing the window all reproduce it — so the crash is reachable from ordinary
//! use.
//!
//! The guard marks a view before Tao starts deallocating its state, then replaces
//! input handlers with trampolines that drop callbacks for detached or deallocating
//! views and forward everything else to Tao untouched. Only pure event-delivery
//! handlers are guarded. Dropping an input event for a view that has no live state
//! is invisible, whereas `viewDidMoveToWindow` and
//! `resetCursorRects` rebuild the tracking rect and cursor rects AppKit relies on;
//! skipping those leaves stale tracking registrations behind and AppKit later
//! aborts trying to weakly reference a deallocating view.

use std::collections::HashMap;
use std::ffi::{c_char, c_void};
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicPtr, Ordering};

use objc2::{msg_send, runtime::AnyObject};

use crate::error::{DesktopError, DesktopResult};

type ArgumentHandler = unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void);
type VoidHandler = unsafe extern "C" fn(*mut c_void, *const c_void);
type InitWithTaoHandler =
    unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void) -> *mut c_void;

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

static LIVE_VIEW_STATES: LazyLock<Mutex<HashMap<usize, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static ORIGINAL_DEALLOC: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static ORIGINAL_INIT_WITH_TAO: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

fn with_live_view_states<T>(action: impl FnOnce(&mut HashMap<usize, usize>) -> T) -> T {
    let mut views = LIVE_VIEW_STATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    action(&mut views)
}

fn registered_view_state(view: *mut c_void) -> Option<*mut c_void> {
    if view.is_null() {
        return None;
    }
    with_live_view_states(|views| {
        views
            .get(&(view as usize))
            .copied()
            .map(|state| state as *mut c_void)
    })
}

fn register_view_state(view: *mut c_void, state: *mut c_void) {
    if view.is_null() || state.is_null() {
        return;
    }
    with_live_view_states(|views| {
        views.insert(view as usize, state as usize);
    });
}

fn unregister_view_state(view: *mut c_void) {
    with_live_view_states(|views| {
        views.remove(&(view as usize));
    });
}

fn read_view_state(view: *mut c_void) -> Option<*mut c_void> {
    if view.is_null() {
        return None;
    }
    let mut state = std::ptr::null_mut();
    let ivar = unsafe { object_getInstanceVariable(view, c"taoState".as_ptr(), &mut state) };
    (!ivar.is_null() && !state.is_null()).then_some(state)
}

unsafe extern "C" fn guarded_dealloc(view: *mut c_void, selector: *const c_void) {
    unregister_view_state(view);
    let original = ORIGINAL_DEALLOC.load(Ordering::Acquire);
    if original.is_null() {
        return;
    }
    let original: VoidHandler = unsafe { std::mem::transmute(original) };
    unsafe { original(view, selector) };
}

unsafe extern "C" fn guarded_init_with_tao(
    view: *mut c_void,
    selector: *const c_void,
    state: *mut c_void,
) -> *mut c_void {
    let original = ORIGINAL_INIT_WITH_TAO.load(Ordering::Acquire);
    if original.is_null() {
        return std::ptr::null_mut();
    }
    let original: InitWithTaoHandler = unsafe { std::mem::transmute(original) };
    let initialized = unsafe { original(view, selector, state) };
    if !initialized.is_null() {
        register_view_state(initialized, state);
    }
    initialized
}

/// True only when Tao has a live `ViewState` attached to this view.
fn view_state_is_attached(view: *mut c_void) -> bool {
    let Some(registered_state) = registered_view_state(view) else {
        return false;
    };
    let Some(state) = read_view_state(view) else {
        return false;
    };
    if state != registered_state {
        return false;
    }

    // Tao keeps a weak NSWindow inside ViewState. On macOS 26, WebKit can send
    // a completed key event or AppKit can send tracking events after NSView has
    // already detached from that window. Calling Tao then dereferences the stale
    // weak window before it can reject the event itself.
    let view = unsafe { &*view.cast::<AnyObject>() };
    let window: *mut AnyObject = unsafe { msg_send![view, window] };
    !window.is_null()
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
guarded_handler!(ORIGINAL_KEY_DOWN, guarded_key_down, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_KEY_UP, guarded_key_up, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_FLAGS_CHANGED, guarded_flags_changed, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_OTHER_MOUSE_UP, guarded_other_mouse_up, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_PRESSURE_CHANGE, guarded_pressure_change, (event: *mut c_void), ArgumentHandler);
guarded_handler!(ORIGINAL_CANCEL_OPERATION, guarded_cancel_operation, (event: *mut c_void), ArgumentHandler);

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
    GuardedSelector {
        name: c"keyDown:",
        original: &ORIGINAL_KEY_DOWN,
        trampoline: guarded_key_down as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"keyUp:",
        original: &ORIGINAL_KEY_UP,
        trampoline: guarded_key_up as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"flagsChanged:",
        original: &ORIGINAL_FLAGS_CHANGED,
        trampoline: guarded_flags_changed as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"otherMouseUp:",
        original: &ORIGINAL_OTHER_MOUSE_UP,
        trampoline: guarded_other_mouse_up as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"pressureChangeWithEvent:",
        original: &ORIGINAL_PRESSURE_CHANGE,
        trampoline: guarded_pressure_change as *const () as *const c_void,
    },
    GuardedSelector {
        name: c"cancelOperation:",
        original: &ORIGINAL_CANCEL_OPERATION,
        trampoline: guarded_cancel_operation as *const () as *const c_void,
    },
];

static INSTALLED: OnceLock<Result<(), String>> = OnceLock::new();

/// Installs the guard once. Tao registers `TaoView` while the first window is
/// created, so this has to run after the window exists and before the event loop
/// starts delivering tracking callbacks.
pub fn install(window: &tauri::Window) -> DesktopResult<()> {
    INSTALLED
        .get_or_init(|| {
            let class = unsafe { objc_getClass(c"TaoView".as_ptr()) };
            if class.is_null() {
                return Err("TaoView is unavailable".to_owned());
            }
            install_handler(
                class,
                c"dealloc",
                &ORIGINAL_DEALLOC,
                guarded_dealloc as *const () as *const c_void,
            )?;
            install_handler(
                class,
                c"initWithTao:",
                &ORIGINAL_INIT_WITH_TAO,
                guarded_init_with_tao as *const () as *const c_void,
            )?;
            for guarded in GUARDED_SELECTORS {
                install_handler(class, guarded.name, guarded.original, guarded.trampoline)?;
            }
            Ok(())
        })
        .as_ref()
        .map(|_| ())
        .map_err(|error| DesktopError::Other(error.clone()))?;

    // Tauri creates the main TaoView before setup runs, so initWithTao: could
    // not register it through the swizzle. Seed that one existing view after
    // every handler has been replaced; later TaoViews register themselves.
    let view = window
        .ns_view()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    let state = read_view_state(view).ok_or_else(|| {
        DesktopError::Other("main TaoView has no live state during initialization".to_owned())
    })?;
    register_view_state(view, state);
    Ok(())
}

fn install_handler(
    class: *mut c_void,
    name: &std::ffi::CStr,
    original_slot: &AtomicPtr<c_void>,
    trampoline: *const c_void,
) -> Result<(), String> {
    let selector = unsafe { sel_registerName(name.as_ptr()) };
    let method = unsafe { class_getInstanceMethod(class, selector) };
    if method.is_null() {
        return Err(format!("TaoView {} is unavailable", name.to_string_lossy()));
    }
    let original = unsafe { method_getImplementation(method) };
    if original.is_null() {
        return Err(format!(
            "TaoView {} has no implementation",
            name.to_string_lossy()
        ));
    }
    original_slot.store(original, Ordering::Release);
    let previous = unsafe { method_setImplementation(method, trampoline) };
    if previous != original {
        return Err(format!(
            "TaoView {} changed during initialization",
            name.to_string_lossy()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        GUARDED_SELECTORS, register_view_state, registered_view_state, unregister_view_state,
        view_state_is_attached,
    };

    #[test]
    fn a_view_without_attached_state_is_never_forwarded() {
        assert!(!view_state_is_attached(std::ptr::null_mut()));
    }

    #[test]
    fn only_the_exact_live_state_is_registered_for_a_view() {
        let view = 0x1000usize as *mut std::ffi::c_void;
        let first_state = 0x2000usize as *mut std::ffi::c_void;
        let replacement_state = 0x3000usize as *mut std::ffi::c_void;

        register_view_state(view, first_state);
        assert_eq!(registered_view_state(view), Some(first_state));

        register_view_state(view, replacement_state);
        assert_eq!(registered_view_state(view), Some(replacement_state));

        unregister_view_state(view);
        assert_eq!(registered_view_state(view), None);
        assert!(!view_state_is_attached(view));
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
            "keyDown:",
            "keyUp:",
            "flagsChanged:",
            "otherMouseUp:",
            "pressureChangeWithEvent:",
            "cancelOperation:",
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
