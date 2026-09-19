pub mod contracts;
pub mod launcher;
pub mod pdf_protocol;
pub mod settings;
pub mod settings_io;
pub mod status;
use contracts::{
    ActivateOrLaunchRequest, AppError, BatchLaunchRequest, BatchLaunchResponse, ErrorCode,
    LaunchResponse, OpenContainingFolderRequest, SaveSettingsResponse, SettingsLoadResponse,
    SyncStatusesRequest, SyncStatusesResponse,
};
use launcher::NativeLauncher;
use pdf_protocol::{NativePdfFileOps, PdfAccessError};
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
            "allow-activate-or-launch",
            "allow-batch-launch-main",
            "allow-open-containing-folder",
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
async fn activate_or_launch(
    window: tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    manager: tauri::State<'_, ConfigManager>,
    launcher: tauri::State<'_, NativeLauncher>,
) -> Result<LaunchResponse, AppError> {
    let request: ActivateOrLaunchRequest =
        contracts::decode(payload(&window, body, true)?, ErrorCode::InvalidRequest)?;
    let material = manager
        .resolve_materials(vec![request.material_id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, None))?;
    let service = launcher.inner().clone();
    tokio::task::spawn_blocking(move || service.activate_or_launch(material))
        .await
        .map_err(|_| AppError::new(ErrorCode::InternalError, None))
}

#[tauri::command]
async fn batch_launch_main(
    window: tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    manager: tauri::State<'_, ConfigManager>,
    launcher: tauri::State<'_, NativeLauncher>,
) -> Result<BatchLaunchResponse, AppError> {
    let request: BatchLaunchRequest =
        contracts::decode(payload(&window, body, true)?, ErrorCode::InvalidRequest)?;
    let materials = manager.resolve_group_main(request.group_id).await?;
    let service = launcher.inner().clone();
    tokio::task::spawn_blocking(move || BatchLaunchResponse {
        results: materials
            .into_iter()
            .map(|m| service.activate_or_launch(m))
            .collect(),
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::InternalError, None))
}

#[tauri::command]
async fn open_containing_folder(
    window: tauri::WebviewWindow,
    body: tauri::ipc::Request<'_>,
    manager: tauri::State<'_, ConfigManager>,
    launcher: tauri::State<'_, NativeLauncher>,
) -> Result<contracts::EmptyResponse, AppError> {
    let request: OpenContainingFolderRequest =
        contracts::decode(payload(&window, body, true)?, ErrorCode::InvalidRequest)?;
    let material = manager
        .resolve_materials(vec![request.material_id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, None))?;
    let service = launcher.inner().clone();
    tokio::task::spawn_blocking(move || service.reveal(material))
        .await
        .map_err(|_| AppError::new(ErrorCode::InternalError, None))?
}

#[tauri::command]
fn health_check() -> Result<String, AppError> {
    Ok("MeetDock backend is ready".to_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("material", |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_owned();
            tauri::async_runtime::spawn(async move {
                let id = pdf_protocol::material_id(request.uri());
                let material = if label != "main" || id.is_none() {
                    Err(PdfAccessError::NotFound)
                } else {
                    let id =
                        contracts::Id::try_from(id.unwrap()).map_err(|_| PdfAccessError::NotFound);
                    match id {
                        Ok(id) => match app
                            .state::<ConfigManager>()
                            .resolve_materials(vec![id])
                            .await
                        {
                            Ok(mut values) => values.pop().ok_or(PdfAccessError::NotFound),
                            Err(error) if error.code == ErrorCode::NotFound => {
                                Err(PdfAccessError::NotFound)
                            }
                            Err(_) => Err(PdfAccessError::Internal),
                        },
                        Err(error) => Err(error),
                    }
                };
                responder.respond(pdf_protocol::serve(
                    request.method(),
                    request.headers(),
                    material.as_ref().map_err(|e| *e),
                    &NativePdfFileOps,
                ));
            });
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            app.manage(PathStatusService::default());
            app.manage(NativeLauncher::default());
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
            sync_material_statuses,
            activate_or_launch,
            batch_launch_main,
            open_containing_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running MeetDock");
}
