//! Bounded top-level window inventory and safe, short-lived window actions.
use crate::contracts::{
    validate_window_exclusions, AppError, ErrorCode, Id, ListWindowsResponse, RequestId,
    SaveWindowExclusionsResponse, WindowActionResponse, WindowListItem,
};
use crate::launcher::LaunchAssociation;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_WINDOWS: usize = 512;
const TOKEN_TTL: Duration = Duration::from_secs(300);
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WindowIdentity {
    hwnd: isize,
    pid: u32,
    process_started: u64,
}

#[derive(Debug, Clone)]
struct NativeWindow {
    identity: WindowIdentity,
    app_name: String,
    title: String,
    executable_name: String,
}

#[derive(Debug, Clone)]
struct EnumeratedWindow {
    window: NativeWindow,
    full_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExcelDocumentObservation {
    hwnd: isize,
    document_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReaderDocumentObservation {
    hwnd: isize,
    document_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OfficeWindowDocumentObservation {
    hwnd: isize,
    document_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotRestorability {
    Restorable,
    Conditional,
    Excluded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_path: Option<String>,
    pub app_name: String,
    pub title: String,
    pub executable_name: String,
    pub executable_path: String,
    pub restorability: SnapshotRestorability,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowSnapshot {
    schema_version: u32,
    pub saved_at_unix_ms: u64,
    pub items: Vec<SnapshotItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SaveSnapshotResult {
    pub saved: bool,
    pub saved_count: usize,
    pub excluded_count: usize,
    pub exclusion_reasons: Vec<String>,
}

#[derive(Debug, Clone)]
struct RegisteredWindow {
    identity: WindowIdentity,
    last_seen: Instant,
}

#[derive(Default)]
struct WindowState {
    next_token: u64,
    entries: HashMap<String, RegisteredWindow>,
    exclusions: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowPreferences {
    schema_version: u32,
    exclusions: Vec<String>,
}

#[derive(Clone)]
pub struct WindowService {
    state: Arc<Mutex<WindowState>>,
    preferences_path: Arc<PathBuf>,
}

impl WindowService {
    pub fn new(preferences_path: PathBuf) -> Self {
        let exclusions = load_preferences(&preferences_path).unwrap_or_default();
        Self {
            state: Arc::new(Mutex::new(WindowState {
                exclusions,
                ..Default::default()
            })),
            preferences_path: Arc::new(preferences_path),
        }
    }

    pub fn list(&self, request_id: RequestId) -> Result<ListWindowsResponse, AppError> {
        let exclusions = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .exclusions
            .clone();
        let mut native = enumerate_native_windows();
        native.retain(|entry| !is_excluded(&entry.window, &exclusions));
        native.sort_by(|a, b| {
            a.window
                .app_name
                .to_lowercase()
                .cmp(&b.window.app_name.to_lowercase())
                .then_with(|| {
                    a.window
                        .title
                        .to_lowercase()
                        .cmp(&b.window.title.to_lowercase())
                })
        });
        native.truncate(MAX_WINDOWS);

        let now = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .entries
            .retain(|_, entry| now.duration_since(entry.last_seen) <= TOKEN_TTL);
        let current: HashSet<_> = native
            .iter()
            .map(|entry| entry.window.identity.clone())
            .collect();
        state
            .entries
            .retain(|_, entry| current.contains(&entry.identity));

        let mut windows = Vec::with_capacity(native.len());
        for entry in native {
            let window = entry.window;
            let token = state
                .entries
                .iter()
                .find_map(|(token, entry)| {
                    (entry.identity == window.identity).then(|| token.clone())
                })
                .unwrap_or_else(|| next_token(&mut state));
            state.entries.insert(
                token.clone(),
                RegisteredWindow {
                    identity: window.identity,
                    last_seen: now,
                },
            );
            windows.push(WindowListItem {
                window_id: Id::try_from(token).expect("generated window id"),
                app_name: window.app_name,
                title: window.title,
                executable_name: window.executable_name,
            });
        }
        Ok(ListWindowsResponse {
            request_id,
            windows,
            exclusions,
        })
    }

    pub(crate) fn save_snapshot(
        &self,
        associations: &[LaunchAssociation],
    ) -> Result<SaveSnapshotResult, AppError> {
        let exclusions = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .exclusions
            .clone();
        let mut reasons = Vec::new();
        let mut items = Vec::new();
        let mut excluded_count = 0;
        let explorer_paths = explorer_window_paths();
        let windows = enumerate_native_windows();
        let excel_paths = excel_window_paths(&windows);
        let reader_paths = reader_window_paths(&windows);
        let word_paths = word_window_paths(&windows);
        let powerpoint_paths = powerpoint_window_paths(&windows);
        for entry in windows.into_iter().take(MAX_WINDOWS) {
            let association = associations.iter().find(|association| {
                association.hwnd == entry.window.identity.hwnd
                    && association.pid == entry.window.identity.pid
                    && association.process_started == entry.window.identity.process_started
            });
            let explorer_path = if entry
                .window
                .executable_name
                .eq_ignore_ascii_case("explorer.exe")
            {
                explorer_paths
                    .get(&entry.window.identity.hwnd)
                    .map(String::as_str)
            } else {
                None
            };
            let excel_path = if entry
                .window
                .executable_name
                .eq_ignore_ascii_case("excel.exe")
            {
                excel_paths
                    .get(&entry.window.identity.hwnd)
                    .map(String::as_str)
            } else {
                None
            };
            let reader_path = if is_supported_acrobat_executable(&entry.window.executable_name) {
                reader_paths
                    .get(&entry.window.identity.hwnd)
                    .map(String::as_str)
            } else {
                None
            };
            let word_path = if entry
                .window
                .executable_name
                .eq_ignore_ascii_case("winword.exe")
            {
                word_paths
                    .get(&entry.window.identity.hwnd)
                    .map(String::as_str)
            } else {
                None
            };
            let powerpoint_path = if entry
                .window
                .executable_name
                .eq_ignore_ascii_case("powerpnt.exe")
            {
                powerpoint_paths
                    .get(&entry.window.identity.hwnd)
                    .map(String::as_str)
            } else {
                None
            };
            let item = snapshot_item(
                entry,
                &exclusions,
                association,
                explorer_path,
                excel_path,
                reader_path,
                word_path,
                powerpoint_path,
            );
            if item.restorability == SnapshotRestorability::Excluded {
                excluded_count += 1;
                if let Some(reason) = &item.reason {
                    reasons.push(reason.clone());
                }
            } else {
                items.push(item);
            }
        }
        reasons.sort();
        reasons.dedup();
        if items.is_empty() {
            return Ok(SaveSnapshotResult {
                saved: false,
                saved_count: 0,
                excluded_count,
                exclusion_reasons: reasons,
            });
        }
        let snapshot = WindowSnapshot {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            saved_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            items: deduplicate_snapshot_items(items),
        };
        persist_snapshot(&self.snapshot_path(), &snapshot)?;
        Ok(SaveSnapshotResult {
            saved: true,
            saved_count: snapshot.items.len(),
            excluded_count,
            exclusion_reasons: reasons,
        })
    }

    pub fn load_snapshot(&self) -> Result<Option<WindowSnapshot>, AppError> {
        load_snapshot_file(&self.snapshot_path())
    }

    pub fn clear_snapshot(&self) -> Result<bool, AppError> {
        clear_snapshot_file(&self.snapshot_path())
    }

    pub(crate) fn launch_snapshot_item(
        &self,
        index: usize,
        associations: &[LaunchAssociation],
    ) -> Result<(), AppError> {
        let snapshot = self
            .load_snapshot()?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, None))?;
        let item = snapshot
            .items
            .get(index)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, None))?;
        if item.restorability == SnapshotRestorability::Excluded
            || item.executable_path.trim().is_empty()
        {
            return Err(AppError::new(ErrorCode::UnsupportedTarget, None));
        }
        if let Some(identity) =
            snapshot_associated_identity(item, associations).filter(validate_native_identity)
        {
            match activate_native(&identity) {
                Ok(()) => return Ok(()),
                Err(error) if error.code == ErrorCode::WindowNotFound => {}
                Err(error) => return Err(error),
            }
        }
        let windows = enumerate_native_windows();
        let explorer_paths = item
            .executable_name
            .eq_ignore_ascii_case("explorer.exe")
            .then(explorer_window_paths)
            .unwrap_or_default();
        if let Some(identity) = snapshot_window_identity(item, &windows, &explorer_paths) {
            match activate_native(&identity) {
                Ok(()) => return Ok(()),
                Err(error) if error.code == ErrorCode::WindowNotFound => {}
                Err(error) => return Err(error),
            }
        }
        snapshot_launch_command(item)
            .spawn()
            .map(|_| ())
            .map_err(|_| AppError::new(ErrorCode::LaunchFailed, None))
    }

    fn snapshot_path(&self) -> PathBuf {
        self.preferences_path.with_file_name("window-snapshot.json")
    }

    pub fn activate(&self, window_id: Id) -> Result<WindowActionResponse, AppError> {
        let identity = self.resolve(&window_id)?;
        activate_native(&identity)?;
        Ok(WindowActionResponse { window_id })
    }

    pub fn request_close(&self, window_id: Id) -> Result<WindowActionResponse, AppError> {
        let identity = self.resolve(&window_id)?;
        close_native(&identity)?;
        Ok(WindowActionResponse { window_id })
    }

    pub fn save_exclusions(
        &self,
        mut patterns: Vec<String>,
    ) -> Result<SaveWindowExclusionsResponse, AppError> {
        validate_window_exclusions(&mut patterns)?;
        persist_preferences(&self.preferences_path, &patterns)?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.exclusions = patterns.clone();
        state.entries.clear();
        Ok(SaveWindowExclusionsResponse { patterns })
    }

    fn resolve(&self, window_id: &Id) -> Result<WindowIdentity, AppError> {
        let now = Instant::now();
        let entry = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .get(window_id.as_str())
            .cloned()
            .filter(|entry| now.duration_since(entry.last_seen) <= TOKEN_TTL)
            .ok_or_else(|| AppError::new(ErrorCode::WindowNotFound, None))?;
        validate_native_identity(&entry.identity)
            .then_some(entry.identity)
            .ok_or_else(|| AppError::new(ErrorCode::WindowNotFound, None))
    }
}

fn snapshot_launch_command(item: &SnapshotItem) -> std::process::Command {
    #[cfg(windows)]
    if let Some(path) = item
        .document_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(path);
        return command;
    }
    std::process::Command::new(&item.executable_path)
}

fn snapshot_path_key(path: &str) -> String {
    crate::contracts::windows_path_key(path)
}

fn deduplicate_snapshot_items(items: Vec<SnapshotItem>) -> Vec<SnapshotItem> {
    let mut targets = HashSet::new();
    items
        .into_iter()
        .filter(|item| {
            targets.insert(crate::contracts::restoration_target_key(
                &item.executable_path,
                item.document_path.as_deref(),
            ))
        })
        .collect()
}

fn snapshot_associated_identity(
    item: &SnapshotItem,
    associations: &[LaunchAssociation],
) -> Option<WindowIdentity> {
    let material_id = item.material_id.as_ref()?;
    associations
        .iter()
        .find(|association| &association.material_id == material_id)
        .map(|association| WindowIdentity {
            hwnd: association.hwnd,
            pid: association.pid,
            process_started: association.process_started,
        })
}

fn snapshot_window_identity(
    item: &SnapshotItem,
    windows: &[EnumeratedWindow],
    explorer_paths: &HashMap<isize, String>,
) -> Option<WindowIdentity> {
    let executable = snapshot_path_key(&item.executable_path);
    let explorer_path = item
        .executable_name
        .eq_ignore_ascii_case("explorer.exe")
        .then(|| item.document_path.as_deref())
        .flatten()
        .map(snapshot_path_key);
    let mut matches = windows.iter().filter(|entry| {
        if snapshot_path_key(&entry.full_path) != executable {
            return false;
        }
        if let Some(path) = explorer_path.as_deref() {
            return explorer_paths
                .get(&entry.window.identity.hwnd)
                .is_some_and(|current| snapshot_path_key(current) == path);
        }
        entry.window.title.eq_ignore_ascii_case(&item.title)
    });
    let identity = matches.next()?.window.identity.clone();
    matches.next().is_none().then_some(identity)
}

fn snapshot_item(
    entry: EnumeratedWindow,
    exclusions: &[String],
    association: Option<&LaunchAssociation>,
    explorer_path: Option<&str>,
    excel_path: Option<&str>,
    reader_path: Option<&str>,
    word_path: Option<&str>,
    powerpoint_path: Option<&str>,
) -> SnapshotItem {
    let excluded = is_excluded(&entry.window, exclusions);
    let path = Path::new(&entry.full_path);
    let (restorability, reason) = if excluded {
        (
            SnapshotRestorability::Excluded,
            Some(format!(
                "{} は除外設定に一致します",
                entry.window.executable_name
            )),
        )
    } else if !path.is_absolute() || !path.is_file() {
        (
            SnapshotRestorability::Conditional,
            Some(format!(
                "{} の実行ファイルを確認できません",
                entry.window.executable_name
            )),
        )
    } else {
        (SnapshotRestorability::Restorable, None)
    };
    SnapshotItem {
        material_id: association.map(|value| value.material_id.clone()),
        document_path: association
            .map(|value| value.material_path.clone())
            .or_else(|| explorer_path.map(str::to_owned))
            .or_else(|| excel_path.map(str::to_owned))
            .or_else(|| reader_path.map(str::to_owned))
            .or_else(|| word_path.map(str::to_owned))
            .or_else(|| powerpoint_path.map(str::to_owned)),
        app_name: entry.window.app_name,
        title: entry.window.title,
        executable_name: entry.window.executable_name,
        executable_path: entry.full_path,
        restorability,
        reason,
    }
}

fn resolve_office_window_paths(
    windows: &[EnumeratedWindow],
    executable_name: &str,
    observations: impl IntoIterator<Item = OfficeWindowDocumentObservation>,
) -> HashMap<isize, String> {
    let hwnds: HashSet<_> = windows
        .iter()
        .filter(|entry| {
            entry
                .window
                .executable_name
                .eq_ignore_ascii_case(executable_name)
        })
        .map(|entry| entry.window.identity.hwnd)
        .collect();
    let mut resolved: HashMap<isize, String> = HashMap::new();
    let mut ambiguous = HashSet::new();
    for observation in observations {
        if !hwnds.contains(&observation.hwnd) || ambiguous.contains(&observation.hwnd) {
            continue;
        }
        if resolved.get(&observation.hwnd).is_some_and(|existing| {
            snapshot_path_key(existing) != snapshot_path_key(&observation.document_path)
        }) {
            resolved.remove(&observation.hwnd);
            ambiguous.insert(observation.hwnd);
        } else {
            resolved.insert(observation.hwnd, observation.document_path);
        }
    }
    resolved
}

fn resolve_reader_window_paths(
    windows: &[EnumeratedWindow],
    observations: impl IntoIterator<Item = ReaderDocumentObservation>,
) -> HashMap<isize, String> {
    let reader_hwnds: HashSet<_> = windows
        .iter()
        .filter(|entry| is_supported_acrobat_executable(&entry.window.executable_name))
        .map(|entry| entry.window.identity.hwnd)
        .collect();
    let mut resolved: HashMap<isize, String> = HashMap::new();
    let mut ambiguous = HashSet::new();
    for observation in observations {
        if !reader_hwnds.contains(&observation.hwnd) || ambiguous.contains(&observation.hwnd) {
            continue;
        }
        if resolved.get(&observation.hwnd).is_some_and(|existing| {
            snapshot_path_key(existing) != snapshot_path_key(&observation.document_path)
        }) {
            resolved.remove(&observation.hwnd);
            ambiguous.insert(observation.hwnd);
        } else {
            resolved.insert(observation.hwnd, observation.document_path);
        }
    }
    resolved
}

fn is_supported_acrobat_executable(executable_name: &str) -> bool {
    executable_name.eq_ignore_ascii_case("acrord32.exe")
        || executable_name.eq_ignore_ascii_case("acrobat.exe")
}

fn resolve_excel_window_paths(
    windows: &[EnumeratedWindow],
    observations: impl IntoIterator<Item = ExcelDocumentObservation>,
) -> HashMap<isize, String> {
    let mut excel_by_pid: HashMap<u32, Vec<isize>> = HashMap::new();
    for entry in windows.iter().filter(|entry| {
        entry
            .window
            .executable_name
            .eq_ignore_ascii_case("excel.exe")
    }) {
        excel_by_pid
            .entry(entry.window.identity.pid)
            .or_default()
            .push(entry.window.identity.hwnd);
    }

    let mut resolved = HashMap::new();
    let mut ambiguous = HashSet::new();
    for observation in observations {
        let Some(entry) = windows.iter().find(|entry| {
            entry.window.identity.hwnd == observation.hwnd
                && entry
                    .window
                    .executable_name
                    .eq_ignore_ascii_case("excel.exe")
        }) else {
            continue;
        };
        if excel_by_pid
            .get(&entry.window.identity.pid)
            .is_none_or(|values| values.len() != 1)
        {
            continue;
        }
        let hwnd = entry.window.identity.hwnd;
        if ambiguous.contains(&hwnd) {
            continue;
        }
        if resolved
            .get(&hwnd)
            .is_some_and(|existing| existing != &observation.document_path)
        {
            resolved.remove(&hwnd);
            ambiguous.insert(hwnd);
        } else {
            resolved.insert(hwnd, observation.document_path);
        }
    }
    resolved
}

fn load_snapshot_file(path: &Path) -> Result<Option<WindowSnapshot>, AppError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AppError::new(ErrorCode::ConfigIo, None)),
    };
    let mut snapshot: WindowSnapshot = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new(ErrorCode::ConfigCorrupt, None))?;
    validate_snapshot(&snapshot)?;
    snapshot.items = deduplicate_snapshot_items(snapshot.items);
    Ok(Some(snapshot))
}

fn clear_snapshot_file(path: &Path) -> Result<bool, AppError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(AppError::new(ErrorCode::ConfigIo, None)),
    }
}

fn validate_snapshot(snapshot: &WindowSnapshot) -> Result<(), AppError> {
    if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION
        || snapshot.items.is_empty()
        || snapshot.items.len() > MAX_WINDOWS
    {
        return Err(AppError::new(ErrorCode::ConfigCorrupt, None));
    }
    for item in &snapshot.items {
        if item.app_name.trim().is_empty()
            || item.title.trim().is_empty()
            || item.executable_name.trim().is_empty()
            || item.executable_path.trim().is_empty()
            || !Path::new(&item.executable_path).is_absolute()
            || item
                .document_path
                .as_deref()
                .is_some_and(|path| path.trim().is_empty() || !Path::new(path).is_absolute())
            || (item.material_id.is_some() && item.document_path.is_none())
            || (item.restorability == SnapshotRestorability::Restorable && item.reason.is_some())
            || (item.restorability != SnapshotRestorability::Restorable
                && item.reason.as_deref().is_none_or(str::is_empty))
            || item.restorability == SnapshotRestorability::Excluded
        {
            return Err(AppError::new(ErrorCode::ConfigCorrupt, None));
        }
    }
    Ok(())
}

fn persist_snapshot(path: &Path, snapshot: &WindowSnapshot) -> Result<(), AppError> {
    validate_snapshot(snapshot)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| AppError::new(ErrorCode::ConfigIo, None))?;
    }
    let bytes = serde_json::to_vec_pretty(snapshot)
        .map_err(|_| AppError::new(ErrorCode::InternalError, None))?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let backup = path.with_extension(format!("json.{}.bak", std::process::id()));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.sync_all()?;
        if path.exists() {
            std::fs::rename(path, &backup)?;
        }
        if let Err(error) = std::fs::rename(&temporary, path) {
            if backup.exists() {
                let _ = std::fs::rename(&backup, path);
            }
            return Err(error);
        }
        if backup.exists() {
            let _ = std::fs::remove_file(&backup);
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(AppError::new(ErrorCode::ConfigIo, None));
    }
    Ok(())
}

fn next_token(state: &mut WindowState) -> String {
    loop {
        state.next_token = state.next_token.wrapping_add(1);
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let token = format!("w_{:016x}_{:016x}", time, state.next_token);
        if !state.entries.contains_key(&token) {
            return token;
        }
    }
}

fn load_preferences(path: &Path) -> Option<Vec<String>> {
    let bytes = std::fs::read(path).ok()?;
    let mut preferences: WindowPreferences = serde_json::from_slice(&bytes).ok()?;
    if preferences.schema_version != 1
        || validate_window_exclusions(&mut preferences.exclusions).is_err()
    {
        return None;
    }
    Some(preferences.exclusions)
}

fn persist_preferences(path: &Path, exclusions: &[String]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| AppError::new(ErrorCode::ConfigIo, None))?;
    }
    let bytes = serde_json::to_vec_pretty(&WindowPreferences {
        schema_version: 1,
        exclusions: exclusions.to_vec(),
    })
    .map_err(|_| AppError::new(ErrorCode::InternalError, None))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|_| AppError::new(ErrorCode::ConfigIo, None))?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|_| AppError::new(ErrorCode::ConfigIo, None))?;
    }
    std::fs::rename(&temporary, path).map_err(|_| AppError::new(ErrorCode::ConfigIo, None))
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let value: Vec<char> = value.to_lowercase().chars().collect();
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for token in pattern {
        let mut current = vec![false; value.len() + 1];
        if token == '*' {
            current[0] = previous[0];
            for index in 1..=value.len() {
                current[index] = previous[index] || current[index - 1];
            }
        } else {
            for index in 1..=value.len() {
                current[index] = previous[index - 1] && (token == '?' || token == value[index - 1]);
            }
        }
        previous = current;
    }
    previous[value.len()]
}

fn is_excluded(window: &NativeWindow, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        glob_matches(pattern, &window.executable_name) || glob_matches(pattern, &window.app_name)
    })
}

fn display_parts(executable_name: &str, title: &str) -> (String, String) {
    let executable = executable_name.to_ascii_lowercase();
    let app_name = match executable.as_str() {
        "explorer.exe" => "エクスプローラー".to_owned(),
        "winword.exe" => "Microsoft Word".to_owned(),
        "excel.exe" => "Microsoft Excel".to_owned(),
        "powerpnt.exe" => "Microsoft PowerPoint".to_owned(),
        "msedge.exe" => "Microsoft Edge".to_owned(),
        "chrome.exe" => "Google Chrome".to_owned(),
        "firefox.exe" => "Mozilla Firefox".to_owned(),
        "notepad.exe" => "メモ帳".to_owned(),
        _ => executable_name
            .strip_suffix(".exe")
            .or_else(|| executable_name.strip_suffix(".EXE"))
            .unwrap_or(executable_name)
            .to_owned(),
    };
    let suffixes: &[&str] = match executable.as_str() {
        "winword.exe" => &[" - Word", " - Microsoft Word"],
        "excel.exe" => &[" - Excel", " - Microsoft Excel"],
        "powerpnt.exe" => &[" - PowerPoint", " - Microsoft PowerPoint"],
        "msedge.exe" => &[" - Microsoft Edge"],
        "chrome.exe" => &[" - Google Chrome"],
        "firefox.exe" => &[" — Mozilla Firefox", " - Mozilla Firefox"],
        "notepad.exe" => &[" - Notepad", " - メモ帳"],
        _ => &[],
    };
    let parsed = suffixes
        .iter()
        .find_map(|suffix| title.strip_suffix(suffix))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(title)
        .trim()
        .to_owned();
    let parsed = if parsed.is_empty() {
        "（タイトルなし）".to_owned()
    } else {
        parsed
    };
    (app_name, parsed)
}

fn explorer_file_url_to_path(url: &str) -> Option<String> {
    let (encoded, unc) = if url
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:///"))
    {
        (&url[8..], false)
    } else if url
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        (&url[7..], true)
    } else {
        return None;
    };
    let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
    let normalized = decoded.replace('/', "\\");
    let path = if unc {
        format!("\\\\{}", normalized.trim_start_matches('\\'))
    } else {
        normalized
    };
    (!path.is_empty() && Path::new(&path).is_absolute()).then_some(path)
}

#[cfg(windows)]
fn excel_window_paths(windows: &[EnumeratedWindow]) -> HashMap<isize, String> {
    resolve_excel_window_paths(windows, excel_document_observations())
}

#[cfg(not(windows))]
fn excel_window_paths(_: &[EnumeratedWindow]) -> HashMap<isize, String> {
    HashMap::new()
}

#[cfg(windows)]
fn excel_document_observations() -> Vec<ExcelDocumentObservation> {
    use windows::{
        core::{IUnknown, Interface, BSTR, GUID, PCWSTR},
        Win32::System::{
            Com::{
                CLSIDFromProgID, CoInitializeEx, CoUninitialize, IDispatch,
                COINIT_APARTMENTTHREADED, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPPARAMS,
            },
            Ole::GetActiveObject,
            Variant::VARIANT,
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    fn invoke(
        dispatch: &IDispatch,
        name: &str,
        flags: windows::Win32::System::Com::DISPATCH_FLAGS,
        arguments: &mut [VARIANT],
    ) -> Option<VARIANT> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let name = PCWSTR(wide.as_ptr());
        let mut id = 0;
        unsafe {
            dispatch
                .GetIDsOfNames(&GUID::zeroed(), &name, 1, 0, &mut id)
                .ok()?;
        }
        let parameters = DISPPARAMS {
            rgvarg: arguments.as_mut_ptr(),
            cArgs: arguments.len() as u32,
            ..Default::default()
        };
        let mut result = VARIANT::default();
        unsafe {
            dispatch
                .Invoke(
                    id,
                    &GUID::zeroed(),
                    0,
                    flags,
                    &parameters,
                    Some(&mut result),
                    None,
                    None,
                )
                .ok()?;
        }
        Some(result)
    }

    fn property(dispatch: &IDispatch, name: &str) -> Option<VARIANT> {
        invoke(dispatch, name, DISPATCH_PROPERTYGET, &mut [])
    }

    fn dispatch_property(dispatch: &IDispatch, name: &str) -> Option<IDispatch> {
        IDispatch::try_from(&property(dispatch, name)?).ok()
    }

    fn integer_property(dispatch: &IDispatch, name: &str) -> Option<i32> {
        i32::try_from(&property(dispatch, name)?).ok()
    }

    fn string_property(dispatch: &IDispatch, name: &str) -> Option<String> {
        let value = property(dispatch, name)?;
        if value.vt() != windows::Win32::System::Variant::VT_BSTR {
            return None;
        }
        let value: &BSTR =
            unsafe { std::mem::transmute(&value.Anonymous.Anonymous.Anonymous.bstrVal) };
        Some(value.to_string())
    }

    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
        return Vec::new();
    }
    let _apartment = ComApartment;
    let Ok(clsid) = (unsafe { CLSIDFromProgID(windows::core::w!("Excel.Application")) }) else {
        return Vec::new();
    };
    let mut unknown: Option<IUnknown> = None;
    if unsafe { GetActiveObject(&clsid, None, &mut unknown) }.is_err() {
        return Vec::new();
    }
    let Some(application) = unknown.and_then(|value| value.cast::<IDispatch>().ok()) else {
        return Vec::new();
    };
    let (Some(hwnd), Some(workbooks)) = (
        integer_property(&application, "Hwnd"),
        dispatch_property(&application, "Workbooks"),
    ) else {
        return Vec::new();
    };
    if integer_property(&workbooks, "Count") != Some(1) {
        return Vec::new();
    }
    let mut index = [VARIANT::from(1i32)];
    let Some(workbook) = invoke(
        &workbooks,
        "Item",
        DISPATCH_PROPERTYGET | DISPATCH_METHOD,
        &mut index,
    )
    .and_then(|value| IDispatch::try_from(&value).ok()) else {
        return Vec::new();
    };
    let Some(path) = string_property(&workbook, "FullName") else {
        return Vec::new();
    };
    let path = crate::contracts::windows_shell_path(&path);
    if !crate::contracts::windows_absolute_path(&path) || !Path::new(&path).is_file() {
        return Vec::new();
    }
    vec![ExcelDocumentObservation {
        hwnd: hwnd as isize,
        document_path: path,
    }]
}

#[cfg(windows)]
fn word_window_paths(windows: &[EnumeratedWindow]) -> HashMap<isize, String> {
    resolve_office_window_paths(
        windows,
        "winword.exe",
        office_window_document_observations("Word.Application", "Document"),
    )
}

#[cfg(not(windows))]
fn word_window_paths(_: &[EnumeratedWindow]) -> HashMap<isize, String> {
    HashMap::new()
}

#[cfg(windows)]
fn powerpoint_window_paths(windows: &[EnumeratedWindow]) -> HashMap<isize, String> {
    resolve_office_window_paths(
        windows,
        "powerpnt.exe",
        office_window_document_observations("PowerPoint.Application", "Presentation"),
    )
}

#[cfg(not(windows))]
fn powerpoint_window_paths(_: &[EnumeratedWindow]) -> HashMap<isize, String> {
    HashMap::new()
}

#[cfg(windows)]
fn office_window_document_observations(
    prog_id: &str,
    document_property: &str,
) -> Vec<OfficeWindowDocumentObservation> {
    use windows::{
        core::{IUnknown, Interface, BSTR, GUID, PCWSTR},
        Win32::System::{
            Com::{
                CLSIDFromProgID, CoInitializeEx, CoUninitialize, IDispatch,
                COINIT_APARTMENTTHREADED, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPPARAMS,
            },
            Ole::GetActiveObject,
            Variant::VARIANT,
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    fn invoke(
        dispatch: &IDispatch,
        name: &str,
        flags: windows::Win32::System::Com::DISPATCH_FLAGS,
        arguments: &mut [VARIANT],
    ) -> Option<VARIANT> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let name = PCWSTR(wide.as_ptr());
        let mut id = 0;
        unsafe {
            dispatch
                .GetIDsOfNames(&GUID::zeroed(), &name, 1, 0, &mut id)
                .ok()?;
        }
        let parameters = DISPPARAMS {
            rgvarg: arguments.as_mut_ptr(),
            cArgs: arguments.len() as u32,
            ..Default::default()
        };
        let mut result = VARIANT::default();
        unsafe {
            dispatch
                .Invoke(
                    id,
                    &GUID::zeroed(),
                    0,
                    flags,
                    &parameters,
                    Some(&mut result),
                    None,
                    None,
                )
                .ok()?;
        }
        Some(result)
    }

    fn property(dispatch: &IDispatch, name: &str) -> Option<VARIANT> {
        invoke(dispatch, name, DISPATCH_PROPERTYGET, &mut [])
    }

    fn dispatch_property(dispatch: &IDispatch, name: &str) -> Option<IDispatch> {
        IDispatch::try_from(&property(dispatch, name)?).ok()
    }

    fn integer_property(dispatch: &IDispatch, name: &str) -> Option<i32> {
        i32::try_from(&property(dispatch, name)?).ok()
    }

    fn string_property(dispatch: &IDispatch, name: &str) -> Option<String> {
        let value = property(dispatch, name)?;
        if value.vt() != windows::Win32::System::Variant::VT_BSTR {
            return None;
        }
        let value: &BSTR =
            unsafe { std::mem::transmute(&value.Anonymous.Anonymous.Anonymous.bstrVal) };
        Some(value.to_string())
    }

    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
        return Vec::new();
    }
    let _apartment = ComApartment;
    let prog_id: Vec<u16> = prog_id.encode_utf16().chain(std::iter::once(0)).collect();
    let Ok(clsid) = (unsafe { CLSIDFromProgID(PCWSTR(prog_id.as_ptr())) }) else {
        return Vec::new();
    };
    let mut unknown: Option<IUnknown> = None;
    if unsafe { GetActiveObject(&clsid, None, &mut unknown) }.is_err() {
        return Vec::new();
    }
    let Some(application) = unknown.and_then(|value| value.cast::<IDispatch>().ok()) else {
        return Vec::new();
    };
    let Some(application_windows) = dispatch_property(&application, "Windows") else {
        return Vec::new();
    };
    let Some(count) = integer_property(&application_windows, "Count") else {
        return Vec::new();
    };
    let mut observations = Vec::new();
    for index in 1..=count.clamp(0, MAX_WINDOWS as i32) {
        let mut argument = [VARIANT::from(index)];
        let Some(window) = invoke(
            &application_windows,
            "Item",
            DISPATCH_PROPERTYGET | DISPATCH_METHOD,
            &mut argument,
        )
        .and_then(|value| IDispatch::try_from(&value).ok()) else {
            continue;
        };
        let (Some(hwnd), Some(document)) = (
            integer_property(&window, "Hwnd"),
            dispatch_property(&window, document_property),
        ) else {
            continue;
        };
        let Some(path) = string_property(&document, "FullName") else {
            continue;
        };
        let path = crate::contracts::windows_shell_path(&path);
        if crate::contracts::windows_absolute_path(&path) && Path::new(&path).is_file() {
            observations.push(OfficeWindowDocumentObservation {
                hwnd: hwnd as isize,
                document_path: path,
            });
        }
    }
    observations
}

#[cfg(windows)]
fn reader_window_paths(windows: &[EnumeratedWindow]) -> HashMap<isize, String> {
    resolve_reader_window_paths(windows, reader_document_observations(windows))
}

#[cfg(not(windows))]
fn reader_window_paths(_: &[EnumeratedWindow]) -> HashMap<isize, String> {
    HashMap::new()
}

#[cfg(windows)]
fn reader_document_observations(windows: &[EnumeratedWindow]) -> Vec<ReaderDocumentObservation> {
    use std::{ffi::c_void, mem::ManuallyDrop};
    use windows::{
        core::{Interface, BOOL, BSTR, GUID, PCWSTR},
        Win32::{
            Foundation::{HWND, LPARAM},
            System::{
                Com::{
                    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, DISPATCH_METHOD,
                    DISPPARAMS,
                },
                Variant::{
                    VARENUM, VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BSTR, VT_BYREF,
                    VT_I4,
                },
            },
            UI::{
                Accessibility::AccessibleObjectFromWindow,
                WindowsAndMessaging::{EnumChildWindows, OBJID_NATIVEOM},
            },
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    fn document_path(hwnd: isize) -> Option<String> {
        use windows::Win32::System::Com::IDispatch;

        let mut object: *mut c_void = std::ptr::null_mut();
        unsafe {
            AccessibleObjectFromWindow(
                HWND(hwnd as *mut c_void),
                OBJID_NATIVEOM.0 as u32,
                &IDispatch::IID,
                &mut object,
            )
            .ok()?;
        }
        if object.is_null() {
            return None;
        }
        let dispatch = unsafe { IDispatch::from_raw(object) };
        let wide: Vec<u16> = "GetDocInfo"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let name = PCWSTR(wide.as_ptr());
        let mut id = 0;
        unsafe {
            dispatch
                .GetIDsOfNames(&GUID::zeroed(), &name, 1, 0, &mut id)
                .ok()?;
        }

        let mut file_name = BSTR::new();
        let mut page_count = 0i32;
        let mut first_visible_page = 0i32;
        let mut last_visible_page = 0i32;
        let mut status = -1i32;
        let mut language = BSTR::new();
        let byref_type = |value: VARENUM| VARENUM(VT_BYREF.0 | value.0);
        let byref_i32 = |value: &mut i32| VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                    vt: byref_type(VT_I4),
                    Anonymous: VARIANT_0_0_0 { plVal: value },
                    ..Default::default()
                }),
            },
        };
        let byref_bstr = |value: &mut BSTR| VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                    vt: byref_type(VT_BSTR),
                    Anonymous: VARIANT_0_0_0 { pbstrVal: value },
                    ..Default::default()
                }),
            },
        };
        // IDispatch arguments are stored in reverse declaration order.
        let mut arguments = [
            byref_bstr(&mut language),
            byref_i32(&mut status),
            byref_i32(&mut last_visible_page),
            byref_i32(&mut first_visible_page),
            byref_i32(&mut page_count),
            byref_bstr(&mut file_name),
        ];
        let parameters = DISPPARAMS {
            rgvarg: arguments.as_mut_ptr(),
            cArgs: arguments.len() as u32,
            ..Default::default()
        };
        unsafe {
            dispatch
                .Invoke(
                    id,
                    &GUID::zeroed(),
                    0,
                    DISPATCH_METHOD,
                    &parameters,
                    None,
                    None,
                    None,
                )
                .ok()?;
        }
        if status != 0 {
            return None;
        }
        let path = crate::contracts::windows_shell_path(&file_name.to_string());
        (crate::contracts::windows_absolute_path(&path) && Path::new(&path).is_file())
            .then_some(path)
    }

    unsafe extern "system" fn collect_child(hwnd: HWND, parameter: LPARAM) -> BOOL {
        let children = unsafe { &mut *(parameter.0 as *mut Vec<isize>) };
        if children.len() >= MAX_WINDOWS {
            return false.into();
        }
        children.push(hwnd.0 as isize);
        true.into()
    }

    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
        return Vec::new();
    }
    let _apartment = ComApartment;
    let mut observations = Vec::new();
    for entry in windows
        .iter()
        .filter(|entry| is_supported_acrobat_executable(&entry.window.executable_name))
    {
        let top_level = entry.window.identity.hwnd;
        let mut candidates = vec![top_level];
        unsafe {
            let _ = EnumChildWindows(
                Some(HWND(top_level as *mut c_void)),
                Some(collect_child),
                LPARAM(&mut candidates as *mut Vec<isize> as isize),
            );
        }
        for hwnd in candidates {
            if let Some(path) = document_path(hwnd) {
                observations.push(ReaderDocumentObservation {
                    hwnd: top_level,
                    document_path: path,
                });
            }
        }
    }
    observations
}

#[cfg(windows)]
fn explorer_window_paths() -> HashMap<isize, String> {
    use std::mem::ManuallyDrop;
    use windows::{
        core::Interface,
        Win32::{
            System::{
                Com::{
                    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER,
                    COINIT_APARTMENTTHREADED,
                },
                Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4},
            },
            UI::Shell::{IShellWindows, IWebBrowser2, ShellWindows},
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
        return HashMap::new();
    }
    let _apartment = ComApartment;
    let Ok(shell_windows): Result<IShellWindows, _> =
        (unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER) })
    else {
        return HashMap::new();
    };
    let Ok(count) = (unsafe { shell_windows.Count() }) else {
        return HashMap::new();
    };
    let mut paths = HashMap::new();
    let mut ambiguous = HashSet::new();
    for index in 0..count.clamp(0, MAX_WINDOWS as i32) {
        let index = VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_I4,
                    Anonymous: VARIANT_0_0_0 { lVal: index },
                    ..Default::default()
                }),
            },
        };
        let Ok(dispatch) = (unsafe { shell_windows.Item(&index) }) else {
            continue;
        };
        let Ok(browser): Result<IWebBrowser2, _> = dispatch.cast() else {
            continue;
        };
        let (Ok(hwnd), Ok(location)) =
            (unsafe { browser.HWND() }, unsafe { browser.LocationURL() })
        else {
            continue;
        };
        if let Some(path) = explorer_file_url_to_path(&location.to_string()) {
            let hwnd = hwnd.0;
            if ambiguous.contains(&hwnd) {
                continue;
            }
            if paths.get(&hwnd).is_some_and(|existing| existing != &path) {
                paths.remove(&hwnd);
                ambiguous.insert(hwnd);
            } else {
                paths.insert(hwnd, path);
            }
        }
    }
    paths
}

#[cfg(not(windows))]
fn explorer_window_paths() -> HashMap<isize, String> {
    HashMap::new()
}

#[cfg(windows)]
fn enumerate_native_windows() -> Vec<EnumeratedWindow> {
    use windows::{
        core::{BOOL, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM},
            Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
            System::Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::WindowsAndMessaging::{
                EnumWindows, GetClassNameW, GetDesktopWindow, GetShellWindow, GetWindow,
                GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
                IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
            },
        },
    };

    unsafe extern "system" fn collect(hwnd: HWND, raw: LPARAM) -> BOOL {
        let output = &mut *(raw.0 as *mut Vec<EnumeratedWindow>);
        if output.len() >= MAX_WINDOWS
            || !IsWindowVisible(hwnd).as_bool()
            || hwnd == GetShellWindow()
            || hwnd == GetDesktopWindow()
            || GetWindow(hwnd, GW_OWNER).is_ok()
            || (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0) != 0
        {
            return true.into();
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return true.into();
        }
        let mut class = [0u16; 128];
        let class_length = GetClassNameW(hwnd, &mut class);
        let class = String::from_utf16_lossy(&class[..class_length.max(0) as usize]);
        if matches!(class.as_str(), "Shell_TrayWnd" | "Progman" | "WorkerW") {
            return true.into();
        }
        let length = GetWindowTextLengthW(hwnd).clamp(0, 4096);
        let mut title = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..copied.max(0) as usize])
            .replace('\0', "")
            .trim()
            .to_owned();
        let mut pid = 0u32;
        if GetWindowThreadProcessId(hwnd, Some(&mut pid)) == 0
            || pid == 0
            || pid == std::process::id()
        {
            return true.into();
        }
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return true.into();
        };
        struct Handle(windows::Win32::Foundation::HANDLE);
        impl Drop for Handle {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let handle = Handle(handle);
        let mut created = Default::default();
        let mut exit = Default::default();
        let mut kernel = Default::default();
        let mut user = Default::default();
        if GetProcessTimes(handle.0, &mut created, &mut exit, &mut kernel, &mut user).is_err() {
            return true.into();
        }
        let process_started =
            ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        let mut path = vec![0u16; 32_768];
        let mut path_length = path.len() as u32;
        if QueryFullProcessImageNameW(
            handle.0,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut path_length,
        )
        .is_err()
            || path_length == 0
        {
            return true.into();
        }
        let full_path = String::from_utf16_lossy(&path[..path_length as usize]);
        let executable_name = full_path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        if executable_name.is_empty() {
            return true.into();
        }
        let (app_name, parsed_title) = display_parts(&executable_name, &title);
        output.push(EnumeratedWindow {
            full_path,
            window: NativeWindow {
                identity: WindowIdentity {
                    hwnd: hwnd.0 as isize,
                    pid,
                    process_started,
                },
                app_name,
                title: parsed_title,
                executable_name,
            },
        });
        true.into()
    }

    let mut output = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut output as *mut _ as isize));
    }
    output
}

#[cfg(not(windows))]
fn enumerate_native_windows() -> Vec<EnumeratedWindow> {
    Vec::new()
}

#[cfg(windows)]
fn validate_native_identity(identity: &WindowIdentity) -> bool {
    use windows::Win32::{
        Foundation::{CloseHandle, HWND},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
    };
    let hwnd = HWND(identity.hwnd as *mut _);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return false;
        }
        let mut pid = 0u32;
        if GetWindowThreadProcessId(hwnd, Some(&mut pid)) == 0 || pid != identity.pid {
            return false;
        }
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        struct Handle(windows::Win32::Foundation::HANDLE);
        impl Drop for Handle {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let handle = Handle(handle);
        let mut created = Default::default();
        let mut exit = Default::default();
        let mut kernel = Default::default();
        let mut user = Default::default();
        GetProcessTimes(handle.0, &mut created, &mut exit, &mut kernel, &mut user).is_ok()
            && (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
                == identity.process_started
    }
}

#[cfg(not(windows))]
fn validate_native_identity(_: &WindowIdentity) -> bool {
    false
}

#[cfg(windows)]
fn activate_native(identity: &WindowIdentity) -> Result<(), AppError> {
    use crate::launcher::{Foreground, NativeForeground};
    NativeForeground
        .activate(identity.hwnd)
        .map_err(|code| AppError::new(code, None))
}

#[cfg(not(windows))]
fn activate_native(_: &WindowIdentity) -> Result<(), AppError> {
    Err(AppError::new(ErrorCode::WindowNotFound, None))
}

#[cfg(windows)]
fn close_native(identity: &WindowIdentity) -> Result<(), AppError> {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE},
    };
    unsafe {
        PostMessageW(
            Some(HWND(identity.hwnd as *mut _)),
            WM_CLOSE,
            WPARAM(0),
            LPARAM(0),
        )
    }
    .map_err(|_| AppError::new(ErrorCode::AccessDenied, None))
}

#[cfg(not(windows))]
fn close_native(_: &WindowIdentity) -> Result<(), AppError> {
    Err(AppError::new(ErrorCode::WindowNotFound, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_is_case_insensitive_full_match_with_star_and_question_only() {
        assert!(glob_matches("*.EXE", "notepad.exe"));
        assert!(glob_matches("win?ord.exe", "WINWORD.EXE"));
        assert!(!glob_matches("note", "notepad.exe"));
        assert!(!glob_matches("a[1]", "a1"));
        assert!(glob_matches("a[1]", "A[1]"));
    }

    #[test]
    fn known_app_suffixes_are_display_help_not_generic_hyphen_parsing() {
        assert_eq!(
            display_parts("WINWORD.EXE", "議事録 - Microsoft Word"),
            ("Microsoft Word".into(), "議事録".into())
        );
        assert_eq!(
            display_parts("custom.exe", "Project - Q3"),
            ("custom".into(), "Project - Q3".into())
        );
        assert_eq!(
            display_parts("custom.exe", ""),
            ("custom".into(), "（タイトルなし）".into())
        );
    }

    #[test]
    fn preferences_are_separate_versioned_and_strict() {
        let directory = std::env::temp_dir().join(format!(
            "meetdock-windowing-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("window-preferences.json");
        persist_preferences(&path, &["*.exe".into()]).unwrap();
        assert_eq!(load_preferences(&path), Some(vec!["*.exe".into()]));
        std::fs::write(
            &path,
            br#"{"schema_version":1,"exclusions":[],"unexpected":true}"#,
        )
        .unwrap();
        assert_eq!(load_preferences(&path), None);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn test_window(executable_path: String) -> EnumeratedWindow {
        EnumeratedWindow {
            window: NativeWindow {
                identity: WindowIdentity {
                    hwnd: 1,
                    pid: 2,
                    process_started: 3,
                },
                app_name: "テストアプリ".into(),
                title: "資料".into(),
                executable_name: "test.exe".into(),
            },
            full_path: executable_path,
        }
    }

    #[test]
    fn snapshot_classifies_restorable_conditional_and_excluded_items() {
        let directory = std::env::temp_dir().join(format!(
            "meetdock-window-snapshot-classify-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("test.exe");
        std::fs::write(&executable, b"test").unwrap();

        let restorable = snapshot_item(
            test_window(executable.to_string_lossy().into_owned()),
            &[],
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(restorable.restorability, SnapshotRestorability::Restorable);
        assert_eq!(restorable.reason, None);

        let associated_window = test_window(executable.to_string_lossy().into_owned());
        let association = LaunchAssociation {
            material_id: Id::try_from("material-1".to_owned()).unwrap(),
            material_path: executable.to_string_lossy().into_owned(),
            hwnd: associated_window.window.identity.hwnd,
            pid: associated_window.window.identity.pid,
            process_started: associated_window.window.identity.process_started,
        };
        let associated = snapshot_item(
            associated_window,
            &[],
            Some(&association),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            associated.material_id.as_ref().map(Id::as_str),
            Some("material-1")
        );
        assert_eq!(associated.document_path, Some(association.material_path));

        let conditional = snapshot_item(
            test_window(directory.join("missing.exe").to_string_lossy().into_owned()),
            &[],
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            conditional.restorability,
            SnapshotRestorability::Conditional
        );
        assert!(conditional.reason.is_some());

        let excluded = snapshot_item(
            test_window(executable.to_string_lossy().into_owned()),
            &["test.exe".into()],
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(excluded.restorability, SnapshotRestorability::Excluded);
        assert!(excluded.reason.is_some());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn explorer_file_urls_decode_only_absolute_filesystem_paths() {
        assert_eq!(
            explorer_file_url_to_path("file:///C:/Meetings/%E8%B3%87%E6%96%99"),
            Some(r"C:\Meetings\資料".into())
        );
        assert_eq!(
            explorer_file_url_to_path("file://server/share/Agenda"),
            Some(r"\\server\share\Agenda".into())
        );
        assert_eq!(explorer_file_url_to_path("search-ms:query=test"), None);
        assert_eq!(explorer_file_url_to_path("file:///relative"), None);
    }

    #[test]
    fn snapshot_uses_explorer_path_without_material_association() {
        let path = r"C:\Meetings\資料";
        let item = snapshot_item(
            test_window(r"C:\Windows\explorer.exe".into()),
            &[],
            None,
            Some(path),
            None,
            None,
            None,
            None,
        );
        assert_eq!(item.material_id, None);
        assert_eq!(item.document_path.as_deref(), Some(path));
        assert!(validate_snapshot(&WindowSnapshot {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            saved_at_unix_ms: 1,
            items: vec![item],
        })
        .is_ok());
    }

    fn excel_window(hwnd: isize, pid: u32) -> EnumeratedWindow {
        let mut entry = test_window(r"C:\Program Files\Microsoft Office\EXCEL.EXE".into());
        entry.window.identity.hwnd = hwnd;
        entry.window.identity.pid = pid;
        entry.window.executable_name = "EXCEL.EXE".into();
        entry.window.app_name = "Microsoft Excel".into();
        entry
    }

    fn reader_window(hwnd: isize, pid: u32) -> EnumeratedWindow {
        let mut entry = test_window(r"C:\Program Files\Adobe\Acrobat Reader\AcroRd32.exe".into());
        entry.window.identity.hwnd = hwnd;
        entry.window.identity.pid = pid;
        entry.window.executable_name = "AcroRd32.exe".into();
        entry.window.app_name = "Adobe Acrobat Reader".into();
        entry
    }

    fn acrobat_pro_window(hwnd: isize, pid: u32) -> EnumeratedWindow {
        let mut entry =
            test_window(r"C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe".into());
        entry.window.identity.hwnd = hwnd;
        entry.window.identity.pid = pid;
        entry.window.executable_name = "Acrobat.exe".into();
        entry.window.app_name = "Adobe Acrobat Pro".into();
        entry
    }

    fn office_window(hwnd: isize, pid: u32, executable_name: &str) -> EnumeratedWindow {
        let mut entry = test_window(format!(
            r"C:\Program Files\Microsoft Office\{executable_name}"
        ));
        entry.window.identity.hwnd = hwnd;
        entry.window.identity.pid = pid;
        entry.window.executable_name = executable_name.into();
        entry.window.app_name = if executable_name.eq_ignore_ascii_case("winword.exe") {
            "Microsoft Word".into()
        } else {
            "Microsoft PowerPoint".into()
        };
        entry
    }

    #[test]
    fn excel_document_path_requires_a_unique_hwnd_and_workbook_mapping() {
        let single = excel_window(101, 42);
        let resolved = resolve_excel_window_paths(
            std::slice::from_ref(&single),
            [ExcelDocumentObservation {
                hwnd: 101,
                document_path: r"C:\Meetings\agenda.xlsx".into(),
            }],
        );
        assert_eq!(
            resolved.get(&101).map(String::as_str),
            Some(r"C:\Meetings\agenda.xlsx")
        );

        let mut second = single.clone();
        second.window.identity.hwnd = 102;
        assert!(resolve_excel_window_paths(
            &[single.clone(), second],
            [ExcelDocumentObservation {
                hwnd: 101,
                document_path: r"C:\Meetings\agenda.xlsx".into(),
            }],
        )
        .is_empty());

        assert!(resolve_excel_window_paths(
            std::slice::from_ref(&single),
            [
                ExcelDocumentObservation {
                    hwnd: 101,
                    document_path: r"C:\Meetings\agenda.xlsx".into(),
                },
                ExcelDocumentObservation {
                    hwnd: 101,
                    document_path: r"C:\Meetings\other.xlsx".into(),
                },
            ],
        )
        .is_empty());
    }

    #[test]
    fn snapshot_uses_excel_path_only_as_the_last_fallback() {
        let excel_path = r"C:\Meetings\external.xlsx";
        let item = snapshot_item(
            excel_window(101, 42),
            &[],
            None,
            None,
            Some(excel_path),
            None,
            None,
            None,
        );
        assert_eq!(item.document_path.as_deref(), Some(excel_path));

        let association = LaunchAssociation {
            material_id: Id::try_from("material-1".to_owned()).unwrap(),
            material_path: r"C:\Meetings\registered.xlsx".into(),
            hwnd: 101,
            pid: 42,
            process_started: 3,
        };
        let associated = snapshot_item(
            excel_window(101, 42),
            &[],
            Some(&association),
            None,
            Some(excel_path),
            None,
            None,
            None,
        );
        assert_eq!(
            associated.document_path.as_deref(),
            Some(r"C:\Meetings\registered.xlsx")
        );
    }

    #[test]
    fn reader_document_path_requires_one_distinct_path_per_window() {
        let reader = reader_window(201, 52);
        let resolved = resolve_reader_window_paths(
            std::slice::from_ref(&reader),
            [ReaderDocumentObservation {
                hwnd: 201,
                document_path: r"C:\Meetings\agenda.pdf".into(),
            }],
        );
        assert_eq!(
            resolved.get(&201).map(String::as_str),
            Some(r"C:\Meetings\agenda.pdf")
        );

        assert!(resolve_reader_window_paths(
            std::slice::from_ref(&reader),
            [
                ReaderDocumentObservation {
                    hwnd: 201,
                    document_path: r"C:\Meetings\agenda.pdf".into(),
                },
                ReaderDocumentObservation {
                    hwnd: 201,
                    document_path: r"C:\Meetings\other.pdf".into(),
                },
            ],
        )
        .is_empty());
        assert!(resolve_reader_window_paths(
            std::slice::from_ref(&reader),
            [ReaderDocumentObservation {
                hwnd: 999,
                document_path: r"C:\Meetings\agenda.pdf".into(),
            }],
        )
        .is_empty());
    }

    #[test]
    fn acrobat_pro_and_reader_paths_require_exact_unique_hwnd_mappings() {
        let reader = reader_window(201, 52);
        let pro = acrobat_pro_window(202, 53);
        let resolved = resolve_reader_window_paths(
            &[reader.clone(), pro.clone()],
            [
                ReaderDocumentObservation {
                    hwnd: 201,
                    document_path: r"C:\Meetings\reader.pdf".into(),
                },
                ReaderDocumentObservation {
                    hwnd: 202,
                    document_path: r"C:\Meetings\pro.pdf".into(),
                },
            ],
        );
        assert_eq!(
            resolved.get(&201).map(String::as_str),
            Some(r"C:\Meetings\reader.pdf")
        );
        assert_eq!(
            resolved.get(&202).map(String::as_str),
            Some(r"C:\Meetings\pro.pdf")
        );

        let mut unrelated = pro.clone();
        unrelated.window.identity.hwnd = 203;
        unrelated.window.executable_name = "AcrobatHelper.exe".into();
        assert!(resolve_reader_window_paths(
            &[unrelated],
            [ReaderDocumentObservation {
                hwnd: 203,
                document_path: r"C:\Meetings\wrong.pdf".into(),
            }],
        )
        .is_empty());

        assert!(resolve_reader_window_paths(
            std::slice::from_ref(&pro),
            [
                ReaderDocumentObservation {
                    hwnd: 202,
                    document_path: r"C:\Meetings\pro.pdf".into(),
                },
                ReaderDocumentObservation {
                    hwnd: 202,
                    document_path: r"C:\Meetings\other.pdf".into(),
                },
            ],
        )
        .is_empty());
    }

    #[test]
    fn snapshot_uses_acrobat_pro_path_after_registered_association() {
        let path = r"C:\Meetings\external-pro.pdf";
        let item = snapshot_item(
            acrobat_pro_window(202, 53),
            &[],
            None,
            None,
            None,
            Some(path),
            None,
            None,
        );
        assert_eq!(item.document_path.as_deref(), Some(path));
    }

    #[test]
    fn snapshot_uses_reader_path_after_registered_association() {
        let reader_path = r"C:\Meetings\external.pdf";
        let item = snapshot_item(
            reader_window(201, 52),
            &[],
            None,
            None,
            None,
            Some(reader_path),
            None,
            None,
        );
        assert_eq!(item.document_path.as_deref(), Some(reader_path));

        let association = LaunchAssociation {
            material_id: Id::try_from("material-reader".to_owned()).unwrap(),
            material_path: r"C:\Meetings\registered.pdf".into(),
            hwnd: 201,
            pid: 52,
            process_started: 3,
        };
        let associated = snapshot_item(
            reader_window(201, 52),
            &[],
            Some(&association),
            None,
            None,
            Some(reader_path),
            None,
            None,
        );
        assert_eq!(
            associated.document_path.as_deref(),
            Some(r"C:\Meetings\registered.pdf")
        );
    }

    #[test]
    fn word_and_powerpoint_paths_require_exact_unique_hwnd_mappings() {
        for (executable, hwnd, path) in [
            ("WINWORD.EXE", 301, r"C:\Meetings\agenda.docx"),
            ("POWERPNT.EXE", 401, r"C:\Meetings\briefing.pptx"),
        ] {
            let window = office_window(hwnd, hwnd as u32, executable);
            let resolved = resolve_office_window_paths(
                std::slice::from_ref(&window),
                executable,
                [OfficeWindowDocumentObservation {
                    hwnd,
                    document_path: path.into(),
                }],
            );
            assert_eq!(resolved.get(&hwnd).map(String::as_str), Some(path));

            assert!(resolve_office_window_paths(
                std::slice::from_ref(&window),
                executable,
                [
                    OfficeWindowDocumentObservation {
                        hwnd,
                        document_path: path.into(),
                    },
                    OfficeWindowDocumentObservation {
                        hwnd,
                        document_path: r"C:\Meetings\other.office".into(),
                    },
                ],
            )
            .is_empty());
        }
    }

    #[test]
    fn snapshot_uses_word_and_powerpoint_paths_after_registered_association() {
        let word_path = r"C:\Meetings\external.docx";
        let word = snapshot_item(
            office_window(301, 61, "WINWORD.EXE"),
            &[],
            None,
            None,
            None,
            None,
            Some(word_path),
            None,
        );
        assert_eq!(word.document_path.as_deref(), Some(word_path));

        let powerpoint_path = r"C:\Meetings\external.pptx";
        let powerpoint = snapshot_item(
            office_window(401, 71, "POWERPNT.EXE"),
            &[],
            None,
            None,
            None,
            None,
            None,
            Some(powerpoint_path),
        );
        assert_eq!(powerpoint.document_path.as_deref(), Some(powerpoint_path));

        let association = LaunchAssociation {
            material_id: Id::try_from("material-word".to_owned()).unwrap(),
            material_path: r"C:\Meetings\registered.docx".into(),
            hwnd: 301,
            pid: 61,
            process_started: 3,
        };
        let associated = snapshot_item(
            office_window(301, 61, "WINWORD.EXE"),
            &[],
            Some(&association),
            None,
            None,
            None,
            Some(word_path),
            None,
        );
        assert_eq!(
            associated.document_path.as_deref(),
            Some(r"C:\Meetings\registered.docx")
        );
    }

    #[test]
    fn snapshot_window_matching_is_exact_unique_and_path_aware_for_explorer() {
        let item = SnapshotItem {
            material_id: None,
            document_path: None,
            app_name: "Editor".into(),
            title: "資料".into(),
            executable_name: "editor.exe".into(),
            executable_path: r"C:\Apps\editor.exe".into(),
            restorability: SnapshotRestorability::Restorable,
            reason: None,
        };
        let current = test_window(r"c:/apps/EDITOR.exe".into());
        assert_eq!(
            snapshot_window_identity(&item, std::slice::from_ref(&current), &HashMap::new()),
            Some(current.window.identity.clone())
        );
        let mut duplicate = current.clone();
        duplicate.window.identity.hwnd = 4;
        assert_eq!(
            snapshot_window_identity(&item, &[current, duplicate], &HashMap::new()),
            None
        );

        let explorer_item = SnapshotItem {
            document_path: Some(r"C:\Meetings\資料".into()),
            executable_name: "explorer.exe".into(),
            executable_path: r"C:\Windows\explorer.exe".into(),
            ..item
        };
        let mut explorer = test_window(r"C:\Windows\explorer.exe".into());
        explorer.window.executable_name = "explorer.exe".into();
        explorer.window.title = "タイトルには依存しない".into();
        let paths = HashMap::from([(explorer.window.identity.hwnd, r"c:/meetings/資料/".into())]);
        assert_eq!(
            snapshot_window_identity(&explorer_item, std::slice::from_ref(&explorer), &paths),
            Some(explorer.window.identity)
        );
    }

    #[test]
    fn snapshot_prefers_a_live_material_association() {
        let material_id = Id::try_from("material-1".to_owned()).unwrap();
        let item = SnapshotItem {
            material_id: Some(material_id.clone()),
            document_path: Some(r"C:\Meetings\agenda.docx".into()),
            app_name: "Editor".into(),
            title: "Agenda".into(),
            executable_name: "editor.exe".into(),
            executable_path: r"C:\Apps\editor.exe".into(),
            restorability: SnapshotRestorability::Restorable,
            reason: None,
        };
        let association = LaunchAssociation {
            material_id,
            material_path: r"C:\Meetings\agenda.docx".into(),
            hwnd: 11,
            pid: 22,
            process_started: 33,
        };
        assert_eq!(
            snapshot_associated_identity(&item, &[association]),
            Some(WindowIdentity {
                hwnd: 11,
                pid: 22,
                process_started: 33,
            })
        );
    }

    #[test]
    fn snapshot_persistence_is_versioned_strict_and_replaces_previous_value() {
        let directory = std::env::temp_dir().join(format!(
            "meetdock-window-snapshot-persist-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("window-snapshot.json");
        let make_snapshot = |title: &str| WindowSnapshot {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            saved_at_unix_ms: 42,
            items: vec![SnapshotItem {
                material_id: None,
                document_path: None,
                app_name: "テストアプリ".into(),
                title: title.into(),
                executable_name: "test.exe".into(),
                executable_path: directory.join("test.exe").to_string_lossy().into_owned(),
                restorability: SnapshotRestorability::Conditional,
                reason: Some("実行ファイルを確認できません".into()),
            }],
        };
        persist_snapshot(&path, &make_snapshot("最初")).unwrap();
        persist_snapshot(&path, &make_snapshot("更新後")).unwrap();
        assert_eq!(
            load_snapshot_file(&path).unwrap().unwrap().items[0].title,
            "更新後"
        );
        assert!(clear_snapshot_file(&path).unwrap());
        assert!(!clear_snapshot_file(&path).unwrap());
        assert!(load_snapshot_file(&path).unwrap().is_none());

        persist_snapshot(&path, &make_snapshot("検証用")).unwrap();

        std::fs::write(
            &path,
            br#"{"schema_version":1,"saved_at_unix_ms":1,"items":[],"unexpected":true}"#,
        )
        .unwrap();
        assert!(load_snapshot_file(&path).is_err());
        std::fs::write(
            &path,
            br#"{"schema_version":99,"saved_at_unix_ms":1,"items":[]}"#,
        )
        .unwrap();
        assert!(load_snapshot_file(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn snapshot_targets_are_normalized_and_deduplicated_on_save_and_load_boundaries() {
        let item = |title: &str, executable_path: &str, document_path: Option<&str>| SnapshotItem {
            material_id: None,
            document_path: document_path.map(str::to_owned),
            app_name: "テストアプリ".into(),
            title: title.into(),
            executable_name: "test.exe".into(),
            executable_path: executable_path.into(),
            restorability: SnapshotRestorability::Restorable,
            reason: None,
        };
        let items = vec![
            item("fallback first", r"C:\Apps\Test.exe", None),
            item("fallback duplicate", r"\\?\c:/APPS/TEST.EXE\", None),
            item(
                "document first",
                r"C:\Apps\Test.exe",
                Some(r"C:\Docs\Agenda.docx"),
            ),
            item(
                "document duplicate",
                r"c:/apps/test.exe/",
                Some(r"\\?\C:\DOCS\AGENDA.DOCX\"),
            ),
            item(
                "distinct document",
                r"C:\Apps\Test.exe",
                Some(r"C:\Docs\Minutes.docx"),
            ),
            item(
                "distinct executable",
                r"C:\Apps\Other.exe",
                Some(r"C:\Docs\Agenda.docx"),
            ),
        ];
        let deduplicated = deduplicate_snapshot_items(items.clone());
        assert_eq!(
            deduplicated
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            vec![
                "fallback first",
                "document first",
                "distinct document",
                "distinct executable"
            ]
        );

        let directory = std::env::temp_dir().join(format!(
            "meetdock-window-snapshot-deduplicate-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("window-snapshot.json");
        persist_snapshot(
            &path,
            &WindowSnapshot {
                schema_version: SNAPSHOT_SCHEMA_VERSION,
                saved_at_unix_ms: 42,
                items,
            },
        )
        .unwrap();
        assert_eq!(load_snapshot_file(&path).unwrap().unwrap().items.len(), 4);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
