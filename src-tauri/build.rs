fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "health_check",
            "load_settings",
            "resolve_settings_issue",
            "save_settings",
            "sync_material_statuses",
            "list_windows",
            "activate_window",
            "close_window",
            "save_window_exclusions",
            "activate_or_launch",
            "batch_launch_main",
            "open_containing_folder",
            "prepare_dropped_files",
        ]),
    ))
    .expect("failed to build MeetDock permissions")
}
