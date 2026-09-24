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
        for entry in enumerate_native_windows().into_iter().take(MAX_WINDOWS) {
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
            let item = snapshot_item(entry, &exclusions, association, explorer_path);
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
            items,
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

    pub fn launch_snapshot_item(&self, index: usize) -> Result<(), AppError> {
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

fn snapshot_item(
    entry: EnumeratedWindow,
    exclusions: &[String],
    association: Option<&LaunchAssociation>,
    explorer_path: Option<&str>,
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
            .or_else(|| explorer_path.map(str::to_owned)),
        app_name: entry.window.app_name,
        title: entry.window.title,
        executable_name: entry.window.executable_name,
        executable_path: entry.full_path,
        restorability,
        reason,
    }
}

fn load_snapshot_file(path: &Path) -> Result<Option<WindowSnapshot>, AppError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AppError::new(ErrorCode::ConfigIo, None)),
    };
    let snapshot: WindowSnapshot = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new(ErrorCode::ConfigCorrupt, None))?;
    validate_snapshot(&snapshot)?;
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
        let associated = snapshot_item(associated_window, &[], Some(&association), None);
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
}
