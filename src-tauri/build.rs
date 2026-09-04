use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn required_string<'a>(document: &'a Value, path: &[&str]) -> &'a str {
    let mut value = document;
    for key in path {
        value = value
            .get(key)
            .unwrap_or_else(|| panic!("generated configuration is missing {}", path.join(".")));
    }
    value.as_str().unwrap_or_else(|| {
        panic!(
            "generated configuration field {} must be a string",
            path.join(".")
        )
    })
}

fn required_bool(document: &Value, path: &[&str]) -> bool {
    let mut value = document;
    for key in path {
        value = value
            .get(key)
            .unwrap_or_else(|| panic!("generated configuration is missing {}", path.join(".")));
    }
    value.as_bool().unwrap_or_else(|| {
        panic!(
            "generated configuration field {} must be a boolean",
            path.join(".")
        )
    })
}

fn emit(name: &str, value: &str) {
    println!("cargo:rustc-env={name}={value}");
}

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is required"));
    let generated = manifest_dir.join("../target/generated");
    let app_path = generated.join("app-config.json");
    let harness_path = generated.join("harness-lock.json");
    println!("cargo:rerun-if-changed={}", app_path.display());
    println!("cargo:rerun-if-changed={}", harness_path.display());
    let app: Value = serde_json::from_str(&fs::read_to_string(&app_path).unwrap_or_else(|error| {
        panic!(
            "run `pnpm app:sync` before building Rust: {}: {error}",
            app_path.display()
        )
    }))
    .expect("generated app-config.json must be valid JSON");
    let harness: Value =
        serde_json::from_str(&fs::read_to_string(&harness_path).unwrap_or_else(|error| {
            panic!(
                "run `pnpm harness:sync` before building Rust: {}: {error}",
                harness_path.display()
            )
        }))
        .expect("generated harness-lock.json must be valid JSON");
    emit(
        "DEEPSEEK_DESKTOP_APP_NAME",
        required_string(&app, &["productName"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_APP_VERSION",
        required_string(&app, &["version"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_APP_DESCRIPTION",
        required_string(&app, &["description"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_APP_AUTHORS",
        &app["authors"]
            .as_array()
            .expect("authors must be an array")
            .iter()
            .map(|value| value.as_str().expect("author must be a string"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    emit(
        "DEEPSEEK_DESKTOP_APP_REPOSITORY",
        required_string(&app, &["repository"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_APP_IDENTIFIER",
        required_string(&app, &["identifier"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_APP_COPYRIGHT",
        required_string(&app, &["copyright"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RELEASE_CHANNEL",
        required_string(&app, &["release", "channel"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_SIGNED_RELEASE",
        if required_bool(&app, &["release", "signed"]) {
            "true"
        } else {
            "false"
        },
    );
    emit(
        "DEEPSEEK_DESKTOP_RUST_VERSION",
        required_string(&app, &["toolchain", "rustVersion"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_VERSION",
        required_string(&harness, &["harness", "version"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_COMMIT",
        required_string(&harness, &["harness", "commit"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_REPOSITORY",
        required_string(&harness, &["harness", "sourceUrl"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_ENTRY",
        required_string(&harness, &["harness", "entry"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_SHA256",
        required_string(&harness, &["harness", "sha256"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_NODE_VERSION",
        required_string(&harness, &["node", "version"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_UPDATE_MANIFEST_URL",
        required_string(&app, &["harnessUpdate", "manifestUrl"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_UPDATE_CHANNEL",
        required_string(&app, &["harnessUpdate", "channel"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_AUTO_UPDATE",
        if required_bool(&app, &["harnessUpdate", "autoUpdate"]) {
            "true"
        } else {
            "false"
        },
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_UPDATE_PUBLISHER",
        required_string(&app, &["harnessUpdate", "publisher"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_UPDATE_PUBLIC_KEY",
        required_string(&app, &["harnessUpdate", "publicKey"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_HARNESS_PROTOCOL_VERSION",
        &app["harnessUpdate"]["harnessProtocolVersion"]
            .as_u64()
            .expect("harness protocol version must be an integer")
            .to_string(),
    );
    emit(
        "DEEPSEEK_DESKTOP_CREDENTIAL_PROTOCOL_VERSION",
        &app["harnessUpdate"]["credentialProtocolVersion"]
            .as_u64()
            .expect("credential protocol version must be an integer")
            .to_string(),
    );
    let target = std::env::var("TARGET").expect("Cargo TARGET is required");
    println!("cargo:rustc-env=DEEPSEEK_DESKTOP_TARGET={target}");
    tauri_build::build()
}
