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
    let runtime_path = generated.join("runtime-lock.json");
    println!("cargo:rerun-if-changed={}", app_path.display());
    println!("cargo:rerun-if-changed={}", runtime_path.display());
    let app: Value = serde_json::from_str(&fs::read_to_string(&app_path).unwrap_or_else(|error| {
        panic!(
            "run `pnpm app:sync` before building Rust: {}: {error}",
            app_path.display()
        )
    }))
    .expect("generated app-config.json must be valid JSON");
    let runtime: Value =
        serde_json::from_str(&fs::read_to_string(&runtime_path).unwrap_or_else(|error| {
            panic!(
                "run `pnpm runtime:sync` before building Rust: {}: {error}",
                runtime_path.display()
            )
        }))
        .expect("generated runtime-lock.json must be valid JSON");
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
        "DEEPSEEK_DESKTOP_RUNTIME_VERSION",
        required_string(&runtime, &["runtime", "version"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_COMMIT",
        required_string(&runtime, &["runtime", "commit"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_REPOSITORY",
        required_string(&runtime, &["runtime", "sourceUrl"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_ENTRY",
        required_string(&runtime, &["runtime", "entry"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_SHA256",
        required_string(&runtime, &["runtime", "sha256"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_NODE_VERSION",
        required_string(&runtime, &["node", "version"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_UPDATE_MANIFEST_URL",
        required_string(&app, &["runtimeUpdate", "manifestUrl"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_UPDATE_CHANNEL",
        required_string(&app, &["runtimeUpdate", "channel"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_AUTO_UPDATE",
        if required_bool(&app, &["runtimeUpdate", "autoUpdate"]) {
            "true"
        } else {
            "false"
        },
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_UPDATE_PUBLISHER",
        required_string(&app, &["runtimeUpdate", "publisher"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_UPDATE_PUBLIC_KEY",
        required_string(&app, &["runtimeUpdate", "publicKey"]),
    );
    emit(
        "DEEPSEEK_DESKTOP_RUNTIME_PROTOCOL_VERSION",
        &app["runtimeUpdate"]["runtimeProtocolVersion"]
            .as_u64()
            .expect("runtime protocol version must be an integer")
            .to_string(),
    );
    emit(
        "DEEPSEEK_DESKTOP_CREDENTIAL_PROTOCOL_VERSION",
        &app["runtimeUpdate"]["credentialProtocolVersion"]
            .as_u64()
            .expect("credential protocol version must be an integer")
            .to_string(),
    );
    let target = std::env::var("TARGET").expect("Cargo TARGET is required");
    println!("cargo:rustc-env=DEEPSEEK_DESKTOP_TARGET={target}");
    tauri_build::build()
}
