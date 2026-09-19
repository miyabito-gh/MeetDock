fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "health_check",
            "load_settings",
            "resolve_settings_issue",
            "save_settings",
        ]),
    ))
    .expect("failed to build MeetDock permissions")
}
