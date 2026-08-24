fn main() {
    if std::env::args().any(|argument| argument == "--keychain-helper") {
        std::process::exit(dsh_desktop_lib::run_keychain_helper());
    }
    dsh_desktop_lib::run();
}
