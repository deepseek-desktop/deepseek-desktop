fn main() {
    if std::env::args().any(|argument| argument == "--credential-vault-helper") {
        std::process::exit(dsh_desktop_lib::run_credential_vault_helper());
    }
    dsh_desktop_lib::run();
}
