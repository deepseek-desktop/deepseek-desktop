fn main() {
    let target = std::env::var("TARGET").expect("Cargo TARGET is required");
    println!("cargo:rustc-env=DEEPSEEK_HARNESS_DESKTOP_TARGET={target}");
    tauri_build::build()
}
