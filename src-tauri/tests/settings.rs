#![cfg(windows)]
use meetdock_lib::{
    contracts::*,
    settings::{ConfigManager, SettingsPaths},
    settings_io::{self, FileOps, NativeFileOps, Stage},
};
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("meetdock-phase3-{}", settings_io::token().unwrap()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn paths(&self) -> SettingsPaths {
        SettingsPaths {
            directory: self.0.clone(),
            legacy: None,
        }
    }
    fn put(&self, name: &str, bytes: &[u8]) {
        fs::write(self.0.join(name), bytes).unwrap();
    }
    fn current(&self) -> Vec<u8> {
        fs::read(self.0.join("settings.json")).unwrap()
    }
    fn manager(&self) -> ConfigManager {
        ConfigManager::new(self.paths(), NativeFileOps)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        // Only the newly generated, direct child of the test temporary directory.
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("meetdock-phase3-"));
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn config(revision: u64) -> Value {
    json!({"schema_version":3,"app_version":"client-untrusted","revision":revision,"last_updated":"2001-01-01T00:00:00Z",
        "groups":[{"id":"g1","parent_id":null,"name":"fixture","order":1}],
        "materials":[{"id":"m1","group_id":"g1","name":"fixture","role":"main","target_type":"file","path":"C:\\Fixtures\\document.pdf","window_match_pattern":null,"order":1}]})
}
fn bytes(revision: u64) -> Vec<u8> {
    serde_json::to_vec(&config(revision)).unwrap()
}
fn request(revision: u64) -> Value {
    json!({"config":config(revision),"expected_revision":revision})
}
fn resolve(action: &str, id: Option<&Id>) -> Value {
    json!({"action":action,"candidate_id":id.map(Id::as_str)})
}
fn assert_code<T: std::fmt::Debug>(result: Result<T, AppError>, code: ErrorCode) {
    let error = result.unwrap_err();
    assert_eq!(error.code, code);
    assert!(!error.message.contains("Fixtures"));
}

#[derive(Clone, Default)]
struct Faults {
    plan: Arc<Mutex<Option<(Stage, u8)>>>,
    stage: Arc<Mutex<Option<Stage>>>,
    trace: Arc<Mutex<Vec<Stage>>>,
}
impl Faults {
    fn arm(&self, stage: Stage, mode: u8) {
        *self.plan.lock().unwrap() = Some((stage, mode));
    }
    fn mode(&self) -> Option<u8> {
        self.plan
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(s, _)| Some(*s) == *self.stage.lock().unwrap())
            .map(|(_, m)| *m)
    }
}
impl FileOps for Faults {
    fn checkpoint(&self, stage: Stage) -> io::Result<()> {
        *self.stage.lock().unwrap() = Some(stage);
        self.trace.lock().unwrap().push(stage);
        if self.mode() == Some(0) {
            Err(io::ErrorKind::PermissionDenied.into())
        } else {
            Ok(())
        }
    }
    fn read(&self, p: &Path) -> io::Result<Option<Vec<u8>>> {
        if self.mode() == Some(2) {
            return Ok(Some(bytes(77)));
        } // Valid JSON, wrong contents.
        if self.mode() == Some(4) {
            NativeFileOps.write(p, &bytes(99), false)?;
        }
        if self.mode() == Some(5) {
            NativeFileOps.write(p, br#"{"schema_version":4}"#, false)?;
        }
        NativeFileOps.read(p)
    }
    fn list(&self, p: &Path) -> io::Result<Vec<PathBuf>> {
        NativeFileOps.list(p)
    }
    fn create_directory(&self, p: &Path) -> io::Result<()> {
        NativeFileOps.create_directory(p)
    }
    fn write(&self, p: &Path, b: &[u8], exclusive: bool) -> io::Result<()> {
        if self.mode() == Some(1) {
            NativeFileOps.write(p, &b[..b.len() / 2], exclusive)?;
            return Err(io::ErrorKind::WriteZero.into());
        }
        NativeFileOps.write(p, b, exclusive)
    }
    fn sync(&self, p: &Path) -> io::Result<()> {
        NativeFileOps.sync(p)
    }
    fn move_file(&self, a: &Path, b: &Path, replace: bool) -> io::Result<()> {
        NativeFileOps.move_file(a, b, replace)
    }
    fn replace(&self, a: &Path, b: &Path, displaced: &Path) -> io::Result<()> {
        if self.mode() == Some(3) {
            NativeFileOps.move_file(a, displaced, false)?;
            return Err(io::Error::from_raw_os_error(1177));
        }
        NativeFileOps.replace(a, b, displaced)
    }
    fn remove(&self, p: &Path) -> io::Result<()> {
        NativeFileOps.remove(p)
    }
}

#[tokio::test]
async fn normal_save_rotates_three_generations_and_owns_metadata() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(0));
    let manager = s.manager();
    for n in 0..5 {
        let input = request(n);
        let untouched = input.clone();
        let response = manager.save_settings(input.clone()).await.unwrap();
        assert_eq!(input, untouched);
        assert_eq!(response.revision.get(), n + 1);
        let saved = decode_config(serde_json::from_slice(&s.current()).unwrap())
            .unwrap()
            .config
            .unwrap();
        assert_eq!(saved.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(saved.last_updated, response.last_updated);
        assert_ne!(saved.last_updated.as_str(), "2001-01-01T00:00:00Z");
    }
    for (name, revision) in [
        ("settings.json.bak1", 4),
        ("settings.json.bak2", 3),
        ("settings.json.bak3", 2),
    ] {
        let value: Value = serde_json::from_slice(&fs::read(s.0.join(name)).unwrap()).unwrap();
        assert_eq!(value["revision"], revision);
    }
    assert_eq!(fs::read_dir(&s.0).unwrap().count(), 4);
}
#[tokio::test]
async fn pristine_first_load_creates_revision_zero_and_repeat_load_does_not_write() {
    let s = Sandbox::new();
    let manager = s.manager();
    let loaded = manager.load_settings(json!({})).await.unwrap();
    assert_eq!(loaded.mode, SettingsMode::Ready);
    assert_eq!(loaded.config.unwrap().revision.get(), 0);
    let old = s.current();
    manager.load_settings(json!({})).await.unwrap();
    assert_eq!(s.current(), old);
}
#[tokio::test]
async fn cfg02_concurrent_saves_serialize_and_loser_conflicts() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(12));
    let manager = s.manager();
    let (a, b) = tokio::join!(
        manager.save_settings(request(12)),
        manager.save_settings(request(12))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_code(if a.is_err() { a } else { b }, ErrorCode::ConfigConflict);
    assert_eq!(
        serde_json::from_slice::<Value>(&s.current()).unwrap()["revision"],
        13
    );
    assert_eq!(fs::read(s.0.join("settings.json.bak1")).unwrap(), bytes(12));
}
#[tokio::test]
async fn cfg02_reloads_disk_revision_instead_of_cached_revision() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(12));
    let manager = s.manager();
    manager.load_settings(json!({})).await.unwrap();
    s.put("settings.json", &bytes(13));
    assert_code(
        manager.save_settings(request(12)).await,
        ErrorCode::ConfigConflict,
    );
    assert_eq!(s.current(), bytes(13));
}
#[tokio::test]
async fn config_revision_mismatch_and_exhaustion_are_validation_errors_without_writes() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(MAX_SAFE));
    let manager = s.manager();
    assert_code(
        manager.save_settings(request(MAX_SAFE)).await,
        ErrorCode::ValidationError,
    );
    let mut req = request(12);
    req["config"]["revision"] = json!(11);
    assert_code(manager.save_settings(req).await, ErrorCode::ValidationError);
    assert_eq!(fs::read_dir(&s.0).unwrap().count(), 1);
}
#[tokio::test]
async fn cfg03_all_shared_invalid_business_fixtures_leave_disk_untouched() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(12));
    let manager = s.manager();
    let fixtures: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/contracts.json")).unwrap();
    for f in fixtures["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["type"] == "AppConfig" && f["valid"] == false)
    {
        assert_code(
            manager
                .save_settings(json!({"config":f["value"],"expected_revision":12}))
                .await,
            ErrorCode::ValidationError,
        );
        assert_eq!(s.current(), bytes(12), "{}", f["name"]);
    }
    assert_eq!(fs::read_dir(&s.0).unwrap().count(), 1);
}
#[tokio::test]
async fn cfg04_future_and_old_schema_never_decode_or_overwrite() {
    for schema in [1, 2, 4, u32::MAX] {
        let s = Sandbox::new();
        let original =
            serde_json::to_vec(&json!({"schema_version":schema,"alien":[true]})).unwrap();
        s.put("settings.json", &original);
        s.put("settings.json.bak1", &bytes(9));
        let manager = s.manager();
        let loaded = manager.load_settings(json!({})).await.unwrap();
        assert_eq!(
            loaded.mode,
            if schema > 3 {
                SettingsMode::ReadOnlyFutureSchema
            } else {
                SettingsMode::ReadOnlyUnavailable
            }
        );
        assert!(loaded.config.is_none() && loaded.candidates.is_empty());
        assert_code(
            manager.save_settings(request(9)).await,
            ErrorCode::ReadOnlySchema,
        );
        for action in ["initialize_empty", "restore_candidate", "import_legacy"] {
            assert_code(manager.resolve_settings_issue(json!({"action":action,"candidate_id":if action=="initialize_empty" { Value::Null } else { json!("guessed") }})).await,ErrorCode::ReadOnlySchema);
        }
        assert_eq!(s.current(), original);
    }
}
#[tokio::test]
async fn cfg05_only_valid_candidates_sorted_no_paths_and_explicit_restore() {
    let s = Sandbox::new();
    s.put("settings.json", b"broken");
    s.put("settings.json.bak1", &bytes(4));
    s.put("settings.json.bak2", b"broken");
    s.put("settings.json.bak3", &bytes(2));
    s.put("settings.json.tmp-fixture", &bytes(9));
    s.put("settings.json.tmp-future", br#"{"schema_version":4}"#);
    s.put("unrelated.json", &bytes(99));
    let manager = s.manager();
    let loaded = manager.load_settings(json!({})).await.unwrap();
    assert_eq!(loaded.mode, SettingsMode::RecoveryRequired);
    assert!(loaded.config.is_none());
    assert_eq!(
        loaded
            .candidates
            .iter()
            .map(|c| c.revision.unwrap().get())
            .collect::<Vec<_>>(),
        vec![9, 4, 2]
    );
    let dto = serde_json::to_string(&loaded).unwrap();
    assert!(!dto.contains("path") && !dto.contains("settings.json"));
    assert_eq!(s.current(), b"broken");
    let restored = manager
        .resolve_settings_issue(resolve(
            "restore_candidate",
            Some(&loaded.candidates[1].candidate_id),
        ))
        .await
        .unwrap();
    assert_eq!(restored.config.unwrap().revision.get(), 4);
    assert_eq!(fs::read(s.0.join("settings.json.bak1")).unwrap(), bytes(4));
    assert!(fs::read_dir(&s.0).unwrap().any(|p| p
        .unwrap()
        .file_name()
        .to_str()
        .unwrap()
        .starts_with("settings.json.replaced-")));
}
#[tokio::test]
async fn candidates_are_revalidated_and_cannot_be_swapped_after_selection() {
    for replacement in [
        b"broken".to_vec(),
        bytes(10),
        br#"{"schema_version":4}"#.to_vec(),
    ] {
        let s = Sandbox::new();
        s.put("settings.json", b"broken");
        s.put("settings.json.bak1", &bytes(9));
        let manager = s.manager();
        let loaded = manager.load_settings(json!({})).await.unwrap();
        s.put("settings.json.bak1", &replacement);
        assert!(manager
            .resolve_settings_issue(resolve(
                "restore_candidate",
                Some(&loaded.candidates[0].candidate_id)
            ))
            .await
            .is_err());
        assert_eq!(s.current(), b"broken");
    }
}
#[tokio::test]
async fn stale_or_unknown_candidates_and_wrong_actions_cannot_write() {
    let s = Sandbox::new();
    s.put("settings.json", b"broken");
    s.put("settings.json.bak1", &bytes(9));
    let manager = s.manager();
    let first = manager.load_settings(json!({})).await.unwrap();
    let second = manager.load_settings(json!({})).await.unwrap();
    assert_code(
        manager
            .resolve_settings_issue(resolve(
                "restore_candidate",
                Some(&first.candidates[0].candidate_id),
            ))
            .await,
        ErrorCode::InvalidRequest,
    );
    assert_code(
        manager
            .resolve_settings_issue(resolve(
                "import_legacy",
                Some(&second.candidates[0].candidate_id),
            ))
            .await,
        ErrorCode::InvalidRequest,
    );
    assert_code(
        manager
            .resolve_settings_issue(json!({"action":"restore_candidate","candidate_id":"guessed"}))
            .await,
        ErrorCode::InvalidRequest,
    );
    assert_eq!(s.current(), b"broken");
}
#[tokio::test]
async fn current_changes_after_prompt_prevent_recovery_and_future_overwrite() {
    for replacement in [bytes(20), br#"{"schema_version":4}"#.to_vec()] {
        let s = Sandbox::new();
        s.put("settings.json", b"broken");
        let manager = s.manager();
        manager.load_settings(json!({})).await.unwrap();
        s.put("settings.json", &replacement);
        assert!(manager
            .resolve_settings_issue(resolve("initialize_empty", None))
            .await
            .is_err());
        assert_eq!(s.current(), replacement);
    }
}
#[tokio::test]
async fn all_corrupt_requires_explicit_initialization_or_session_read_only() {
    let s = Sandbox::new();
    s.put("settings.json", b"broken");
    s.put("settings.json.bak1", b"broken");
    let manager = s.manager();
    let loaded = manager.load_settings(json!({})).await.unwrap();
    assert_eq!(loaded.mode, SettingsMode::RecoveryRequired);
    assert!(loaded.candidates.is_empty());
    manager
        .resolve_settings_issue(resolve("open_read_only", None))
        .await
        .unwrap();
    assert_code(
        manager
            .resolve_settings_issue(resolve("initialize_empty", None))
            .await,
        ErrorCode::ReadOnlySchema,
    );
    assert_code(
        manager.save_settings(request(0)).await,
        ErrorCode::ReadOnlySchema,
    );
    assert_eq!(s.current(), b"broken");
    assert_eq!(
        manager.load_settings(json!({})).await.unwrap().mode,
        SettingsMode::ReadOnlyUnavailable
    );
    let restarted = s.manager();
    restarted.load_settings(json!({})).await.unwrap();
    let initialized = restarted
        .resolve_settings_issue(resolve("initialize_empty", None))
        .await
        .unwrap()
        .config
        .unwrap();
    assert_eq!(initialized.revision.get(), 0);
    assert!(initialized.groups.is_empty());
}
#[tokio::test]
async fn valid_current_wins_over_higher_revision_temp_without_auto_restore() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(5));
    s.put("settings.json.tmp-fixture", &bytes(6));
    let loaded = s.manager().load_settings(json!({})).await.unwrap();
    assert_eq!(loaded.config.unwrap().revision.get(), 5);
    assert_eq!(s.current(), bytes(5));
}
#[tokio::test]
async fn missing_current_with_even_corrupt_residue_does_not_initialize_automatically() {
    for residue in [bytes(6), b"broken".to_vec()] {
        let s = Sandbox::new();
        s.put("settings.json.tmp-fixture", &residue);
        let loaded = s.manager().load_settings(json!({})).await.unwrap();
        assert_eq!(loaded.mode, SettingsMode::RecoveryRequired);
        assert!(!s.0.join("settings.json").exists());
    }
}
#[tokio::test]
async fn legacy_import_requires_missing_current_full_validation_and_explicit_action() {
    let s = Sandbox::new();
    let legacy = s.0.join("legacy.json");
    s.put("legacy.json", &bytes(17));
    let manager = ConfigManager::new(
        SettingsPaths {
            directory: s.0.join("new"),
            legacy: Some(legacy.clone()),
        },
        NativeFileOps,
    );
    let loaded = manager.load_settings(json!({})).await.unwrap();
    assert_eq!(loaded.mode, SettingsMode::MigrationRequired);
    assert!(!s.0.join("new/settings.json").exists());
    assert_code(
        manager
            .resolve_settings_issue(resolve(
                "restore_candidate",
                Some(&loaded.candidates[0].candidate_id),
            ))
            .await,
        ErrorCode::InvalidRequest,
    );
    let result = manager
        .resolve_settings_issue(resolve(
            "import_legacy",
            Some(&loaded.candidates[0].candidate_id),
        ))
        .await
        .unwrap();
    assert_eq!(result.config.unwrap().revision.get(), 17);
    assert_eq!(fs::read(&legacy).unwrap(), bytes(17));
    assert!(manager
        .load_settings(json!({}))
        .await
        .unwrap()
        .candidates
        .is_empty());
}
#[tokio::test]
async fn legacy_not_offered_for_existing_corrupt_current_or_invalid_legacy() {
    let s = Sandbox::new();
    s.put("settings.json", b"broken");
    s.put("legacy.json", &bytes(10));
    let manager = ConfigManager::new(
        SettingsPaths {
            directory: s.0.clone(),
            legacy: Some(s.0.join("legacy.json")),
        },
        NativeFileOps,
    );
    assert!(manager
        .load_settings(json!({}))
        .await
        .unwrap()
        .candidates
        .is_empty());
    for invalid in [br#"{"schema_version":2}"#.to_vec(), b"broken".to_vec()] {
        let child = s.0.join(settings_io::token().unwrap());
        s.put("legacy.json", &invalid);
        let manager = ConfigManager::new(
            SettingsPaths {
                directory: child,
                legacy: Some(s.0.join("legacy.json")),
            },
            NativeFileOps,
        );
        let loaded = manager.load_settings(json!({})).await.unwrap();
        assert!(loaded.candidates.is_empty());
        assert_eq!(fs::read(s.0.join("legacy.json")).unwrap(), invalid);
    }
}
#[tokio::test]
async fn every_precommit_stage_failure_preserves_current_and_client_edit() {
    for stage in [
        Stage::ReadCurrent,
        Stage::CreateDirectory,
        Stage::TempWrite,
        Stage::TempSync,
        Stage::TempVerify,
        Stage::BackupWrite,
        Stage::BackupSync,
        Stage::BackupVerify,
        Stage::RotateThree,
        Stage::RotateTwo,
        Stage::RotateOne,
        Stage::BeforeCommit,
        Stage::Replace,
    ] {
        let s = Sandbox::new();
        s.put("settings.json", &bytes(12));
        for n in 1..=3 {
            s.put(&format!("settings.json.bak{n}"), &bytes(12 - n));
        }
        let faults = Faults::default();
        faults.arm(stage, 0);
        let manager = ConfigManager::new(s.paths(), faults.clone());
        let input = request(12);
        assert_code(
            manager.save_settings(input.clone()).await,
            ErrorCode::ConfigIo,
        );
        assert_eq!(input, request(12));
        assert_eq!(s.current(), bytes(12), "{stage:?}");
        // A fresh manager still returns the original current, never auto-promotes temp.
        assert_eq!(
            s.manager()
                .load_settings(json!({}))
                .await
                .unwrap()
                .config
                .unwrap()
                .revision
                .get(),
            12
        );
    }
}
#[tokio::test]
async fn partial_writes_and_valid_but_wrong_rereads_do_not_commit() {
    for (stage, mode) in [
        (Stage::TempWrite, 1),
        (Stage::BackupWrite, 1),
        (Stage::TempVerify, 2),
        (Stage::BackupVerify, 2),
    ] {
        let s = Sandbox::new();
        s.put("settings.json", &bytes(12));
        let faults = Faults::default();
        faults.arm(stage, mode);
        assert_code(
            ConfigManager::new(s.paths(), faults)
                .save_settings(request(12))
                .await,
            ErrorCode::ConfigIo,
        );
        assert_eq!(s.current(), bytes(12));
    }
}
#[tokio::test]
async fn first_move_failure_retains_verified_temp_as_explicit_candidate() {
    let s = Sandbox::new();
    let faults = Faults::default();
    faults.arm(Stage::FirstMove, 0);
    assert_code(
        ConfigManager::new(s.paths(), faults)
            .load_settings(json!({}))
            .await,
        ErrorCode::ConfigIo,
    );
    let loaded = s.manager().load_settings(json!({})).await.unwrap();
    assert_eq!(loaded.mode, SettingsMode::RecoveryRequired);
    assert_eq!(loaded.candidates.len(), 1);
}
#[tokio::test]
async fn replace_1177_simulation_retains_old_and_new_as_candidates_without_auto_restore() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(12));
    let faults = Faults::default();
    faults.arm(Stage::Replace, 3);
    assert_code(
        ConfigManager::new(s.paths(), faults)
            .save_settings(request(12))
            .await,
        ErrorCode::ConfigIo,
    );
    let loaded = s.manager().load_settings(json!({})).await.unwrap();
    assert_eq!(loaded.mode, SettingsMode::RecoveryRequired);
    assert_eq!(loaded.candidates[0].revision.unwrap().get(), 13);
    assert!(loaded
        .candidates
        .iter()
        .any(|c| c.revision.unwrap().get() == 12));
    assert!(!s.0.join("settings.json").exists());
}
#[tokio::test]
async fn commit_is_success_even_if_cleanup_checkpoint_fails() {
    for stage in [Stage::Committed, Stage::Cleanup] {
        let s = Sandbox::new();
        s.put("settings.json", &bytes(12));
        let faults = Faults::default();
        faults.arm(stage, 0);
        let saved = ConfigManager::new(s.paths(), faults)
            .save_settings(request(12))
            .await
            .unwrap();
        assert_eq!(saved.revision.get(), 13);
        assert_eq!(
            s.manager()
                .load_settings(json!({}))
                .await
                .unwrap()
                .config
                .unwrap()
                .revision
                .get(),
            13
        );
    }
}
#[tokio::test]
async fn malformed_ipc_requests_cross_strict_decode_before_any_io() {
    let s = Sandbox::new();
    let manager = s.manager();
    assert_code(
        manager.load_settings(json!({"unknown":true})).await,
        ErrorCode::InvalidRequest,
    );
    assert_code(
        manager
            .resolve_settings_issue(json!({"action":"initialize_empty"}))
            .await,
        ErrorCode::InvalidRequest,
    );
    assert_code(
        manager
            .save_settings(json!({"config":config(12),"expected_revision":12,"unknown":true}))
            .await,
        ErrorCode::ValidationError,
    );
    let mut positional = request(12);
    positional["config"]["groups"][0] = json!(["g1", null, "fixture", 1]);
    assert_code(
        manager.save_settings(positional).await,
        ErrorCode::ValidationError,
    );
    assert_eq!(fs::read_dir(&s.0).unwrap().count(), 0);
}

#[tokio::test]
async fn external_change_during_preparation_is_not_overwritten() {
    for mode in [4, 5] {
        let s = Sandbox::new();
        s.put("settings.json", &bytes(12));
        let faults = Faults::default();
        faults.arm(Stage::BeforeCommit, mode);
        assert_code(
            ConfigManager::new(s.paths(), faults)
                .save_settings(request(12))
                .await,
            ErrorCode::ConfigConflict,
        );
        assert_eq!(
            s.current(),
            if mode == 4 {
                bytes(99)
            } else {
                br#"{"schema_version":4}"#.to_vec()
            }
        );
    }
}
#[tokio::test]
async fn future_schema_read_only_is_sticky_until_restart() {
    let s = Sandbox::new();
    s.put("settings.json", br#"{"schema_version":4}"#);
    let manager = s.manager();
    manager.load_settings(json!({})).await.unwrap();
    s.put("settings.json", &bytes(12));
    assert_code(
        manager.save_settings(request(12)).await,
        ErrorCode::ReadOnlySchema,
    );
    assert_eq!(
        manager.load_settings(json!({})).await.unwrap().mode,
        SettingsMode::ReadOnlyUnavailable
    );
}
#[tokio::test]
async fn denied_current_read_is_io_error_and_never_initializes() {
    let s = Sandbox::new();
    s.put("settings.json", &bytes(12));
    let faults = Faults::default();
    faults.arm(Stage::ReadCurrent, 0);
    assert_code(
        ConfigManager::new(s.paths(), faults)
            .load_settings(json!({}))
            .await,
        ErrorCode::ConfigIo,
    );
    assert_eq!(s.current(), bytes(12));
}
#[tokio::test]
async fn legacy_declined_is_not_presented_again_in_the_session() {
    let s = Sandbox::new();
    s.put("legacy.json", &bytes(12));
    let manager = ConfigManager::new(
        SettingsPaths {
            directory: s.0.join("new"),
            legacy: Some(s.0.join("legacy.json")),
        },
        NativeFileOps,
    );
    assert_eq!(
        manager.load_settings(json!({})).await.unwrap().mode,
        SettingsMode::MigrationRequired
    );
    manager
        .resolve_settings_issue(resolve("open_read_only", None))
        .await
        .unwrap();
    assert_eq!(
        manager.load_settings(json!({})).await.unwrap().mode,
        SettingsMode::ReadOnlyUnavailable
    );
    assert!(!s.0.join("new/settings.json").exists());
    assert_eq!(fs::read(s.0.join("legacy.json")).unwrap(), bytes(12));
}
