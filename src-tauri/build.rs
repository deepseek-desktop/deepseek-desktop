fn main() {
    let target = std::env::var("TARGET").expect("Cargo TARGET is required");
    println!("cargo:rustc-env=DSH_DESKTOP_TARGET={target}");
    tauri_build::build()
}
