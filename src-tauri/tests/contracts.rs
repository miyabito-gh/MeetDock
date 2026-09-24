use meetdock_lib::contracts::*;
use serde_json::Value;

fn check(kind: &str, value: Value) -> Result<Value, AppError> {
    macro_rules! decode_as {
        ($t:ty) => {
            serde_json::to_value(decode::<$t>(value, ErrorCode::ValidationError)?)
                .map_err(|_| AppError::new(ErrorCode::InternalError, None))
        };
    }
    match kind {
        "AppConfig" => decode_as!(AppConfig),
        "GroupItem" => decode_as!(GroupItem),
        "MaterialItem" => decode_as!(MaterialItem),
        "SettingsCandidate" => decode_as!(SettingsCandidate),
        "SettingsLoadResponse" => decode_as!(SettingsLoadResponse),
        "AppError" => decode_as!(AppError),
        "MaterialStatusResult" => decode_as!(MaterialStatusResult),
        "LaunchResponse" => decode_as!(LaunchResponse),
        "LoadSettingsRequest" => decode_as!(LoadSettingsRequest),
        "EmptyResponse" => decode_as!(EmptyResponse),
        "ResolveSettingsIssueRequest" => decode_as!(ResolveSettingsIssueRequest),
        "SaveSettingsRequest" => decode_as!(SaveSettingsRequest),
        "SaveSettingsResponse" => decode_as!(SaveSettingsResponse),
        "SyncStatusesRequest" => decode_as!(SyncStatusesRequest),
        "SyncStatusesResponse" => decode_as!(SyncStatusesResponse),
        "ActivateOrLaunchRequest" => decode_as!(ActivateOrLaunchRequest),
        "OpenContainingFolderRequest" => decode_as!(OpenContainingFolderRequest),
        "BatchLaunchRequest" => decode_as!(BatchLaunchRequest),
        "BatchLaunchResponse" => decode_as!(BatchLaunchResponse),
        "ConfigDocument" => Ok(serde_json::to_value(decode_config(value)?).unwrap()),
        _ => panic!("unknown fixture type {kind}"),
    }
}
#[test]
fn shared_contract_fixtures() {
    let data: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/contracts.json")).unwrap();
    for f in data["fixtures"].as_array().unwrap() {
        let result = check(f["type"].as_str().unwrap(), f["value"].clone());
        assert_eq!(
            result.is_ok(),
            f["valid"].as_bool().unwrap(),
            "{}: {:?}",
            f["name"],
            result
        );
        if let Ok(value) = result {
            if let Some(expected) = f.get("normalized") {
                assert_eq!(&value, expected, "{}", f["name"]);
            }
            if f["type"] == "ConfigDocument" && f["value"]["schema_version"] != 3 {
                assert!(value["config"].is_null());
            }
        }
    }
}
#[test]
fn revision_cannot_overflow_and_errors_are_safe() {
    assert!(Revision::try_from(MAX_SAFE).unwrap().next().is_err());
    assert_eq!(Revision::try_from(12).unwrap().next().unwrap().get(), 13);
    let e = decode::<ActivateOrLaunchRequest>(
        serde_json::json!({"material_id":"../secret"}),
        ErrorCode::InvalidRequest,
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidRequest);
    assert!(!e.message.contains("secret"));
}

#[test]
fn serde_defaults_preserve_strict_object_contracts() {
    let config = serde_json::json!({
        "schema_version": 3,
        "app_version": "0.1.0",
        "revision": 1,
        "last_updated": "2026-09-25T00:00:00Z",
        "groups": [{"id":"g1","parent_id":null,"name":"会議","order":1}],
        "materials": []
    });
    let decoded = decode::<AppConfig>(config.clone(), ErrorCode::ValidationError).unwrap();
    assert_eq!(decoded.explorer_open_mode, ExplorerOpenMode::NewWindow);
    assert_eq!(
        decoded.groups[0].explorer_open_mode,
        GroupExplorerOpenMode::Inherit
    );

    let mut missing_required = config.clone();
    missing_required.as_object_mut().unwrap().remove("groups");
    assert!(decode::<AppConfig>(missing_required, ErrorCode::ValidationError).is_err());
    assert!(decode::<GroupItem>(
        serde_json::json!(["g1", null, "会議", 1]),
        ErrorCode::ValidationError
    )
    .is_err());
}
