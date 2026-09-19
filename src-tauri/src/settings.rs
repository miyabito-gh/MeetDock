//! ConfigManager owns serialization, revision checks and explicit recovery decisions.
use crate::{
    contracts::*,
    settings_io::{self, FileOps, NativeFileOps, Stage},
};
use serde_json::Value;
use std::{io, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct SettingsPaths {
    pub directory: PathBuf,
    pub legacy: Option<PathBuf>,
}
impl SettingsPaths {
    fn current(&self) -> PathBuf {
        self.directory.join("settings.json")
    }
    fn named(&self, name: &str) -> PathBuf {
        self.directory.join(name)
    }
}
struct Candidate {
    dto: SettingsCandidate,
    path: PathBuf,
    bytes: Vec<u8>,
}
struct Issue {
    current: Option<Vec<u8>>,
    mode: SettingsMode,
    candidates: Vec<Candidate>,
}
#[derive(Default)]
struct Session {
    read_only: bool,
    issue: Option<Issue>,
}
pub struct ConfigManager<F: FileOps = NativeFileOps> {
    files: Arc<F>,
    paths: SettingsPaths,
    session: Arc<Mutex<Session>>,
}
fn error(code: ErrorCode) -> AppError {
    AppError::new(code, None)
}
fn io_result<T>(r: io::Result<T>) -> Result<T, AppError> {
    r.map_err(|_| error(ErrorCode::ConfigIo))
}
fn checkpoint(files: &impl FileOps, stage: Stage) -> Result<(), AppError> {
    io_result(files.checkpoint(stage))
}
fn document(bytes: &[u8]) -> Result<SettingsLoadResponse, AppError> {
    let value = serde_json::from_slice(bytes).map_err(|_| error(ErrorCode::ConfigCorrupt))?;
    decode_config(value).map_err(|_| error(ErrorCode::ConfigCorrupt))
}
fn valid_config(bytes: &[u8]) -> Result<AppConfig, AppError> {
    document(bytes)?
        .config
        .ok_or_else(|| error(ErrorCode::ReadOnlySchema))
}
fn ready(config: AppConfig) -> SettingsLoadResponse {
    SettingsLoadResponse {
        mode: SettingsMode::Ready,
        config: Some(config),
        source_schema_version: Some(3),
        candidates: vec![],
        notice_code: None,
    }
}
fn unavailable() -> SettingsLoadResponse {
    SettingsLoadResponse {
        mode: SettingsMode::ReadOnlyUnavailable,
        config: None,
        source_schema_version: None,
        candidates: vec![],
        notice_code: Some("READ_ONLY_SCHEMA".into()),
    }
}
fn empty_config() -> Result<AppConfig, AppError> {
    Ok(AppConfig {
        schema_version: 3,
        app_version: env!("CARGO_PKG_VERSION").into(),
        revision: Revision::try_from(0).unwrap(),
        last_updated: settings_io::now()?,
        groups: vec![],
        materials: vec![],
    })
}

impl<F: FileOps> ConfigManager<F> {
    pub fn new(paths: SettingsPaths, files: F) -> Self {
        Self {
            files: Arc::new(files),
            paths,
            session: Arc::new(Mutex::new(Session::default())),
        }
    }
    // Lock BEFORE entering the blocking pool. At most one filesystem task per manager;
    // cancellation of an IPC future cannot release the lock while a write is in flight.
    async fn run<T: Send + 'static>(
        &self,
        action: impl FnOnce(&F, &SettingsPaths, &mut Session) -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let mut session = self.session.clone().lock_owned().await;
        let files = self.files.clone();
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || action(&files, &paths, &mut session))
            .await
            .map_err(|_| error(ErrorCode::InternalError))?
    }
    pub async fn load_settings(&self, request: Value) -> Result<SettingsLoadResponse, AppError> {
        let _: LoadSettingsRequest = decode(request, ErrorCode::InvalidRequest)?;
        self.run(load).await
    }
    /// Resolve execution data from the persisted document. Callers never supply paths.
    pub async fn resolve_materials(&self, ids: Vec<Id>) -> Result<Vec<MaterialItem>, AppError> {
        self.run(move |files, paths, session| {
            if session.issue.is_some() {
                return Err(error(ErrorCode::ConfigCorrupt));
            }
            let bytes =
                read_current(files, paths)?.ok_or_else(|| error(ErrorCode::ConfigCorrupt))?;
            let config = valid_config(&bytes)?;
            let mut result = Vec::with_capacity(ids.len());
            for id in ids {
                let material = config
                    .materials
                    .iter()
                    .find(|m| m.id == id)
                    .ok_or_else(|| AppError::new(ErrorCode::NotFound, Some(id.clone())))?;
                result.push(material.clone());
            }
            Ok(result)
        })
        .await
    }
    /// Resolve all main materials for one persisted group in stable configured order.
    pub async fn resolve_group_main(&self, group_id: Id) -> Result<Vec<MaterialItem>, AppError> {
        self.run(move |files, paths, session| {
            if session.issue.is_some() {
                return Err(error(ErrorCode::ConfigCorrupt));
            }
            let bytes =
                read_current(files, paths)?.ok_or_else(|| error(ErrorCode::ConfigCorrupt))?;
            let config = valid_config(&bytes)?;
            if !config.groups.iter().any(|group| group.id == group_id) {
                return Err(AppError::new(ErrorCode::NotFound, None));
            }
            let mut materials: Vec<_> = config
                .materials
                .into_iter()
                .filter(|material| {
                    material.group_id == group_id && material.role == MaterialRole::Main
                })
                .collect();
            materials.sort_by_key(|material| material.order);
            Ok(materials)
        })
        .await
    }
    pub async fn save_settings(&self, request: Value) -> Result<SaveSettingsResponse, AppError> {
        let request: SaveSettingsRequest = decode(request, ErrorCode::ValidationError)?;
        self.run(move |files, paths, session| {
            if session.read_only {
                return Err(error(ErrorCode::ReadOnlySchema));
            }
            let old = read_current(files, paths)?;
            let saved = valid_config(
                old.as_deref()
                    .ok_or_else(|| error(ErrorCode::ConfigCorrupt))?,
            )?;
            if session.issue.is_some() {
                return Err(error(ErrorCode::ConfigCorrupt));
            }
            if saved.revision != request.expected_revision {
                return Err(error(ErrorCode::ConfigConflict));
            }
            let mut config = request.config;
            config.revision = request.expected_revision.next()?;
            config.last_updated = settings_io::now()?;
            config.app_version = env!("CARGO_PKG_VERSION").into();
            config.validate()?;
            persist(files, paths, &config, old.as_deref())?;
            Ok(SaveSettingsResponse {
                revision: config.revision,
                last_updated: config.last_updated,
            })
        })
        .await
    }
    pub async fn resolve_settings_issue(
        &self,
        request: Value,
    ) -> Result<SettingsLoadResponse, AppError> {
        let request: ResolveSettingsIssueRequest = decode(request, ErrorCode::InvalidRequest)?;
        self.run(move |files, paths, session| {
            if request.action == ResolveAction::OpenReadOnly {
                session.read_only = true;
                session.issue = None;
                let current = read_current(files, paths)?;
                if let Some(bytes) = current {
                    if let Ok(response) = document(&bytes) {
                        if response.config.is_none() {
                            return Ok(response);
                        }
                    }
                }
                return Ok(unavailable());
            }
            if session.read_only {
                return Err(error(ErrorCode::ReadOnlySchema));
            }
            let old = read_current(files, paths)?;
            // Always discriminate schema again: a file may have changed since the prompt.
            if let Some(bytes) = &old {
                if let Ok(response) = document(bytes) {
                    if response.config.is_none() {
                        return Err(error(ErrorCode::ReadOnlySchema));
                    }
                }
            }
            let issue = session
                .issue
                .as_ref()
                .ok_or_else(|| error(ErrorCode::InvalidRequest))?;
            if old != issue.current {
                return Err(error(ErrorCode::ConfigConflict));
            }
            let mut config = match request.action {
                ResolveAction::InitializeEmpty => {
                    if issue.mode != SettingsMode::RecoveryRequired {
                        return Err(error(ErrorCode::InvalidRequest));
                    }
                    empty_config()?
                }
                ResolveAction::RestoreCandidate | ResolveAction::ImportLegacy => {
                    let candidate = issue
                        .candidates
                        .iter()
                        .find(|c| Some(&c.dto.candidate_id) == request.candidate_id.as_ref())
                        .ok_or_else(|| error(ErrorCode::InvalidRequest))?;
                    let legacy = candidate.dto.kind == CandidateKind::Legacy;
                    if legacy != (request.action == ResolveAction::ImportLegacy)
                        || (legacy && old.is_some())
                    {
                        return Err(error(ErrorCode::InvalidRequest));
                    }
                    checkpoint(files, Stage::ReadCandidate)?;
                    let bytes = io_result(files.read(&candidate.path))?
                        .ok_or_else(|| error(ErrorCode::ConfigCorrupt))?;
                    let config = valid_config(&bytes)?;
                    if bytes != candidate.bytes {
                        return Err(error(ErrorCode::ConfigConflict));
                    }
                    config
                }
                ResolveAction::OpenReadOnly => unreachable!(),
            };
            // Restore/import retain the validated source revision. Normal saves alone increment.
            config.last_updated = settings_io::now()?;
            config.app_version = env!("CARGO_PKG_VERSION").into();
            config.validate()?;
            persist(files, paths, &config, old.as_deref())?;
            session.issue = None;
            Ok(ready(config))
        })
        .await
    }
}
fn read_current(files: &impl FileOps, paths: &SettingsPaths) -> Result<Option<Vec<u8>>, AppError> {
    checkpoint(files, Stage::ReadCurrent)?;
    io_result(files.read(&paths.current()))
}
fn load(
    files: &impl FileOps,
    paths: &SettingsPaths,
    session: &mut Session,
) -> Result<SettingsLoadResponse, AppError> {
    let old = read_current(files, paths)?;
    if let Some(bytes) = &old {
        if let Ok(response) = document(bytes) {
            session.issue = None;
            if response.config.is_none() {
                session.read_only = true;
                return Ok(response);
            }
            if session.read_only {
                return Ok(unavailable());
            }
            return Ok(response);
        }
    }
    if session.read_only {
        return Ok(unavailable());
    }
    // Invalidate previously presented IDs even if discovery later fails.
    session.issue = None;
    checkpoint(files, Stage::Discover)?;
    let mut sources: Vec<_> = io_result(files.list(&paths.directory))?
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?;
            let kind = if matches!(
                name,
                "settings.json.bak1"
                    | "settings.json.bak2"
                    | "settings.json.bak3"
                    | "settings.json.bak.new"
            ) || (name.starts_with("settings.json.replaced-")
                && name.ends_with(".tmp"))
            {
                CandidateKind::Backup
            } else if name.starts_with("settings.json.tmp-") {
                CandidateKind::Temporary
            } else {
                return None;
            };
            Some((path, kind))
        })
        .collect();
    let had_artifacts = !sources.is_empty();
    if old.is_none() && !had_artifacts {
        if let Some(legacy) = &paths.legacy {
            sources.push((legacy.clone(), CandidateKind::Legacy));
        }
    }
    sources.sort_by(|a, b| a.0.cmp(&b.0));
    let mut candidates = vec![];
    for (path, kind) in sources {
        checkpoint(files, Stage::ReadCandidate)?;
        let Some(bytes) = io_result(files.read(&path))? else {
            continue;
        };
        let Ok(config) = valid_config(&bytes) else {
            continue;
        };
        candidates.push(Candidate {
            dto: SettingsCandidate {
                candidate_id: Id::try_from(settings_io::token()?)
                    .map_err(|_| error(ErrorCode::InternalError))?,
                kind,
                revision: Some(config.revision),
                last_updated: Some(config.last_updated),
            },
            path,
            bytes,
        });
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.dto.revision.unwrap().get()));
    if old.is_none() && !had_artifacts && candidates.is_empty() {
        let config = empty_config()?;
        persist(files, paths, &config, None)?;
        return Ok(ready(config));
    }
    let mode = if old.is_none()
        && !had_artifacts
        && candidates
            .iter()
            .any(|c| c.dto.kind == CandidateKind::Legacy)
    {
        SettingsMode::MigrationRequired
    } else {
        SettingsMode::RecoveryRequired
    };
    let response = SettingsLoadResponse {
        mode,
        config: None,
        source_schema_version: None,
        candidates: candidates.iter().map(|c| c.dto.clone()).collect(),
        notice_code: Some(
            if mode == SettingsMode::MigrationRequired {
                "MIGRATION_REQUIRED"
            } else {
                "CONFIG_CORRUPT"
            }
            .into(),
        ),
    };
    session.issue = Some(Issue {
        current: old,
        mode,
        candidates,
    });
    Ok(response)
}

fn verify(files: &impl FileOps, path: &std::path::Path, expected: &[u8]) -> Result<(), AppError> {
    let bytes = io_result(files.read(path))?.ok_or_else(|| error(ErrorCode::ConfigIo))?;
    if bytes != expected || valid_config(&bytes).is_err() {
        return Err(error(ErrorCode::ConfigIo));
    }
    Ok(())
}
fn persist(
    files: &impl FileOps,
    paths: &SettingsPaths,
    config: &AppConfig,
    old: Option<&[u8]>,
) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| error(ErrorCode::InternalError))?;
    // Full decode/Validate is used for both generated and reread documents.
    valid_config(&bytes)?;
    checkpoint(files, Stage::CreateDirectory)?;
    io_result(files.create_directory(&paths.directory))?;
    let token = settings_io::token()?;
    let temp = paths.named(&format!("settings.json.tmp-{token}"));
    let displaced = paths.named(&format!("settings.json.replaced-{token}.tmp"));
    checkpoint(files, Stage::TempWrite)?;
    io_result(files.write(&temp, &bytes, true))?;
    checkpoint(files, Stage::TempSync)?;
    io_result(files.sync(&temp))?;
    checkpoint(files, Stage::TempVerify)?;
    verify(files, &temp, &bytes)?;
    let valid_old = old.is_some_and(|b| valid_config(b).is_ok());
    if valid_old {
        let backup = paths.named("settings.json.bak.new");
        checkpoint(files, Stage::BackupWrite)?;
        io_result(files.write(&backup, old.unwrap(), false))?;
        checkpoint(files, Stage::BackupSync)?;
        io_result(files.sync(&backup))?;
        checkpoint(files, Stage::BackupVerify)?;
        verify(files, &backup, old.unwrap())?;
        for (stage, from, to) in [
            (
                Stage::RotateThree,
                "settings.json.bak2",
                "settings.json.bak3",
            ),
            (Stage::RotateTwo, "settings.json.bak1", "settings.json.bak2"),
            (
                Stage::RotateOne,
                "settings.json.bak.new",
                "settings.json.bak1",
            ),
        ] {
            checkpoint(files, stage)?;
            if io_result(files.read(&paths.named(from)))?.is_some() {
                io_result(files.move_file(&paths.named(from), &paths.named(to), true))?;
            }
        }
    }
    checkpoint(files, Stage::BeforeCommit)?;
    // This catches external edits during preparation. Multi-process CAS is not claimed.
    if io_result(files.read(&paths.current()))?.as_deref() != old {
        return Err(error(ErrorCode::ConfigConflict));
    }
    if old.is_some() {
        checkpoint(files, Stage::Replace)?;
        io_result(files.replace(&paths.current(), &temp, &displaced))?;
    } else {
        checkpoint(files, Stage::FirstMove)?;
        io_result(files.move_file(&temp, &paths.current(), false))?;
    }
    // Atomic rename is the commit point. Cleanup failures must not report a failed save
    // after revision has committed. Residues remain eligible for next-start validation.
    let _ = files.checkpoint(Stage::Committed);
    if valid_old && files.checkpoint(Stage::Cleanup).is_ok() {
        let _ = files.remove(&displaced);
    }
    Ok(())
}
