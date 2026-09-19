pub mod contracts;
pub mod settings;
pub mod settings_io;
pub mod status;
use contracts::{
    AppError, ErrorCode, SaveSettingsResponse, SettingsLoadResponse, SyncStatusesRequest,
    SyncStatusesResponse,
};
use settings::{ConfigManager, SettingsPaths};
use settings_io::NativeFileOps;
use status::PathStatusService;
use tauri::Manager;

fn payload(
    window: &tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    wrapped: bool,
) -> Result<serde_json::Value, AppError> {
    decode_payload(window.label(), body.body(), wrapped)
}
fn decode_payload(
    label: &str,
    body: &tauri::ipc::InvokeBody,
    wrapped: bool,
) -> Result<serde_json::Value, AppError> {
    if label != "main" {
        return Err(AppError::new(ErrorCode::AccessDenied, None));
    }
    let tauri::ipc::InvokeBody::Json(value) = body else {
        return Err(AppError::new(ErrorCode::InvalidRequest, None));
    };
    if !wrapped {
        return Ok(value.clone());
    }
    let object = value
        .as_object()
        .filter(|o| o.len() == 1 && o.contains_key("request"))
        .ok_or_else(|| AppError::new(ErrorCode::InvalidRequest, None))?;
    Ok(object["request"].clone())
}

#[cfg(test)]
mod ipc_tests {
    use super::*;
    use serde_json::json;
    use tauri::ipc::InvokeBody;

    #[test]
    fn settings_command_envelope_is_strict_and_main_only() {
        let body =
            InvokeBody::Json(json!({"request":{"action":"initialize_empty","candidate_id":null}}));
        assert_eq!(
            decode_payload("main", &body, true).unwrap(),
            json!({"action":"initialize_empty","candidate_id":null})
        );
        assert_eq!(
            decode_payload("other", &body, true).unwrap_err().code,
            ErrorCode::AccessDenied
        );
        for body in [
            InvokeBody::Raw(vec![]),
            InvokeBody::Json(json!({})),
            InvokeBody::Json(json!({"request":{},"extra":true})),
            InvokeBody::Json(json!([])),
        ] {
            assert_eq!(
                decode_payload("main", &body, true).unwrap_err().code,
                ErrorCode::InvalidRequest
            );
        }
        let load = decode_payload("main", &InvokeBody::Json(json!({"extra":true})), false).unwrap();
        assert!(contracts::decode::<contracts::LoadSettingsRequest>(
            load,
            ErrorCode::InvalidRequest
        )
        .is_err());
    }

    #[test]
    fn generated_settings_capabilities_are_local_and_main_only() {
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        let main = &capabilities["default"];
        assert_eq!(main["local"], true);
        assert_eq!(main["windows"], json!(["main"]));
        assert!(main.get("remote").is_none());
        for permission in [
            "allow-load-settings",
            "allow-save-settings",
            "allow-resolve-settings-issue",
            "allow-sync-material-statuses",
        ] {
            assert!(main["permissions"]
                .as_array()
                .unwrap()
                .contains(&json!(permission)));
        }
    }
}

#[tauri::command]
async fn load_settings(
    window: tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    manager: tauri::State<'_, ConfigManager>,
) -> Result<SettingsLoadResponse, AppError> {
    manager.load_settings(payload(&window, body, false)?).await
}
#[tauri::command]
async fn resolve_settings_issue(
    window: tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    manager: tauri::State<'_, ConfigManager>,
) -> Result<SettingsLoadResponse, AppError> {
    manager
        .resolve_settings_issue(payload(&window, body, true)?)
        .await
}
#[tauri::command]
async fn save_settings(
    window: tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    manager: tauri::State<'_, ConfigManager>,
) -> Result<SaveSettingsResponse, AppError> {
    manager.save_settings(payload(&window, body, true)?).await
}

#[tauri::command]
async fn sync_material_statuses(
    window: tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    manager: tauri::State<'_, ConfigManager>,
    statuses: tauri::State<'_, PathStatusService>,
) -> Result<SyncStatusesResponse, AppError> {
    let request: SyncStatusesRequest =
        contracts::decode(payload(&window, body, true)?, ErrorCode::InvalidRequest)?;
    let materials = manager.resolve_materials(request.material_ids).await?;
    let service = statuses.inner().clone();
    let mut tasks = tokio::task::JoinSet::new();
    for (index, material) in materials.into_iter().enumerate() {
        let service = service.clone();
        tasks.spawn(async move { (index, service.check(material).await) });
    }
    let mut indexed = Vec::new();
    while let Some(value) = tasks.join_next().await {
        indexed.push(value.map_err(|_| AppError::new(ErrorCode::InternalError, None))?);
    }
    indexed.sort_by_key(|(index, _)| *index);
    let results = indexed.into_iter().map(|(_, value)| value).collect();
    Ok(SyncStatusesResponse {
        request_id: request.request_id,
        results,
    })
}

#[tauri::command]
fn health_check() -> Result<String, AppError> {
    Ok("MeetDock backend is ready".to_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            app.manage(PathStatusService::default());
            app.manage(ConfigManager::new(
                SettingsPaths {
                    directory: app.path().app_config_dir()?,
                    legacy: Some(
                        app.path()
                            .config_dir()?
                            .join("com.launcher.meeting")
                            .join("settings.json"),
                    ),
                },
                NativeFileOps,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            load_settings,
            resolve_settings_issue,
            save_settings,
            sync_material_statuses
        ])
        .run(tauri::generate_context!())
        .expect("error while running MeetDock");
}
