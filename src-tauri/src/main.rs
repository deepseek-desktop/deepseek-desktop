fn main() {
    if std::env::args().any(|argument| argument == "--credential-vault-helper") {
        std::process::exit(deepseek_harness_desktop_lib::run_credential_vault_helper());
    }
    deepseek_harness_desktop_lib::run();
}
