use std::process::Command;

pub fn configure(command: &mut Command, repository: &str) {
    configure_with(
        command,
        repository,
        |name| std::env::var_os(name).is_some(),
        system_proxy,
    );
}

fn configure_with(
    command: &mut Command,
    repository: &str,
    has_environment: impl Fn(&str) -> bool,
    resolve: impl FnOnce(&str) -> Option<String>,
) {
    let Ok(url) = url::Url::parse(repository) else {
        return;
    };
    let (lower, upper) = match url.scheme() {
        "https" => ("https_proxy", "HTTPS_PROXY"),
        "http" => ("http_proxy", "HTTP_PROXY"),
        _ => return,
    };
    if [lower, upper, "all_proxy", "ALL_PROXY"]
        .into_iter()
        .any(has_environment)
    {
        return;
    }
    if let Some(proxy) = resolve(repository) {
        // Git's explicit http.proxy config and NO_PROXY still take precedence.
        command.env(lower, proxy);
    }
}

#[cfg(not(target_os = "macos"))]
fn system_proxy(_repository: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn system_proxy(repository: &str) -> Option<String> {
    macos::resolve(repository)
}

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::{CFURL, CFURLCreateWithString, CFURLRef};

    #[link(name = "CFNetwork", kind = "framework")]
    unsafe extern "C" {
        fn CFNetworkCopySystemProxySettings() -> CFDictionaryRef;
        fn CFNetworkCopyProxiesForURL(url: CFURLRef, settings: CFDictionaryRef) -> CFArrayRef;
        static kCFProxyTypeKey: CFStringRef;
        static kCFProxyHostNameKey: CFStringRef;
        static kCFProxyPortNumberKey: CFStringRef;
        static kCFProxyTypeHTTP: CFStringRef;
        static kCFProxyTypeHTTPS: CFStringRef;
        static kCFProxyTypeSOCKS: CFStringRef;
    }

    pub(super) fn resolve(repository: &str) -> Option<String> {
        // Copy APIs return owned references; CF wrappers release them on every exit.
        unsafe {
            let settings = CFNetworkCopySystemProxySettings();
            if settings.is_null() {
                return None;
            }
            let settings: CFDictionary = TCFType::wrap_under_create_rule(settings);
            resolve_with_settings(repository, &settings)
        }
    }

    fn resolve_with_settings(repository: &str, settings: &CFDictionary) -> Option<String> {
        unsafe {
            let value = CFString::new(repository);
            let url = CFURLCreateWithString(
                std::ptr::null(),
                value.as_concrete_TypeRef(),
                std::ptr::null(),
            );
            if url.is_null() {
                return None;
            }
            let url: CFURL = TCFType::wrap_under_create_rule(url);
            let proxies = CFNetworkCopyProxiesForURL(
                url.as_concrete_TypeRef(),
                settings.as_concrete_TypeRef(),
            );
            if proxies.is_null() {
                return None;
            }
            let proxies: CFArray<CFType> = TCFType::wrap_under_create_rule(proxies);
            let proxy = proxies.get(0)?.downcast::<CFDictionary>()?;
            let get = |key: CFStringRef| -> Option<CFType> {
                proxy
                    .find(key.cast())
                    .map(|value| TCFType::wrap_under_get_rule(*value))
            };
            let kind = get(kCFProxyTypeKey)?.downcast::<CFString>()?;
            let matches = |value| kind == CFString::wrap_under_get_rule(value);
            let scheme = if matches(kCFProxyTypeHTTP) || matches(kCFProxyTypeHTTPS) {
                "http"
            } else if matches(kCFProxyTypeSOCKS) {
                "socks5h"
            } else {
                // Respect DIRECT/bypass. PAC is not a static proxy endpoint.
                return None;
            };
            let host = get(kCFProxyHostNameKey)?
                .downcast::<CFString>()?
                .to_string();
            let port = get(kCFProxyPortNumberKey)?
                .downcast::<CFNumber>()?
                .to_i64()?;
            let port = u16::try_from(port).ok().filter(|port| *port != 0)?;
            let mut proxy_url = url::Url::parse(&format!("{scheme}://localhost")).ok()?;
            proxy_url.set_host(Some(&host)).ok()?;
            proxy_url.set_port(Some(port)).ok()?;
            Some(proxy_url.to_string())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use core_foundation::boolean::CFBoolean;

        #[test]
        fn system_resolution_respects_https_and_bypass_rules() {
            let settings = CFDictionary::from_CFType_pairs(&[
                (CFString::new("HTTPSEnable"), CFNumber::from(1).as_CFType()),
                (
                    CFString::new("HTTPSProxy"),
                    CFString::new("127.0.0.1").as_CFType(),
                ),
                (
                    CFString::new("HTTPSPort"),
                    CFNumber::from(18080).as_CFType(),
                ),
                (
                    CFString::new("ExcludeSimpleHostnames"),
                    CFBoolean::true_value().as_CFType(),
                ),
                (
                    CFString::new("ExceptionsList"),
                    CFArray::from_CFTypes(&[CFString::new("*.internal")]).as_CFType(),
                ),
            ])
            .to_untyped();
            assert_eq!(
                resolve_with_settings("https://example.test/runtime.git", &settings).as_deref(),
                Some("http://127.0.0.1:18080/")
            );
            assert_eq!(
                resolve_with_settings("https://git.internal/runtime.git", &settings),
                None
            );
            assert_eq!(
                resolve_with_settings("http://example.test/runtime.git", &settings),
                None
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_git_commands_receive_a_system_proxy() {
        let mut command = Command::new("git");
        configure_with(
            &mut command,
            "https://example.test/runtime.git",
            |_| false,
            |_| Some("http://localhost:18080".to_owned()),
        );
        assert_eq!(
            command.get_envs().collect::<Vec<_>>(),
            vec![(
                "https_proxy".as_ref(),
                Some("http://localhost:18080".as_ref())
            )]
        );
        for repository in [
            "file:///tmp/runtime",
            "git@example.test:runtime.git",
            "ssh://example.test/runtime.git",
        ] {
            configure_with(
                &mut command,
                repository,
                |_| false,
                |_| panic!("must not resolve non-HTTP repositories"),
            );
        }
    }

    #[test]
    fn explicit_environment_including_empty_proxy_is_preserved() {
        for name in ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] {
            let mut command = Command::new("git");
            configure_with(
                &mut command,
                "https://example.test/runtime.git",
                |key| key == name,
                |_| panic!("must preserve explicit proxy configuration"),
            );
            assert_eq!(command.get_envs().count(), 0);
        }
    }
}
