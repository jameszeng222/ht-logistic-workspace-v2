fn main() {
    // Ensure pi-runtime.7z exists as a placeholder for dev builds.
    //
    // tauri.conf.json declares "pi-runtime.7z" as a bundle resource, so
    // tauri_build::build() checks the file exists at compile time. In dev mode
    // the real 7z is never built (only build-installer.ps1 creates it), so we
    // create a 1-byte placeholder here. At runtime, ensure_pi_runtime_extracted()
    // tries to extract it, fails gracefully (returns None), and find_pi() falls
    // through to dev-mode paths (current_exe parents / cwd / PATH).
    //
    // In release builds, build-installer.ps1 creates the real 7z before invoking
    // tauri build, so this code sees the real file and does nothing.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let placeholder = std::path::Path::new(&manifest_dir).join("pi-runtime.7z");
    if !placeholder.exists() {
        let _ = std::fs::write(&placeholder, [0u8]);
    }

    tauri_build::build()
}
