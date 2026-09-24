//! Bounded top-level window inventory and safe, short-lived window actions.
use crate::contracts::{
    validate_window_exclusions, AppError, ErrorCode, Id, ListWindowsResponse, RequestId,
    SaveWindowExclusionsResponse, WindowActionResponse, WindowListItem,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_WINDOWS: usize = 512;
const TOKEN_TTL: Duration = Duration::from_secs(300);

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
        native.retain(|window| !is_excluded(window, &exclusions));
        native.sort_by(|a, b| {
            a.app_name
                .to_lowercase()
                .cmp(&b.app_name.to_lowercase())
                .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
        });
        native.truncate(MAX_WINDOWS);

        let now = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .entries
            .retain(|_, entry| now.duration_since(entry.last_seen) <= TOKEN_TTL);
        let current: HashSet<_> = native.iter().map(|window| window.identity.clone()).collect();
        state
            .entries
            .retain(|_, entry| current.contains(&entry.identity));

        let mut windows = Vec::with_capacity(native.len());
        for window in native {
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
        std::fs::create_dir_all(parent)
            .map_err(|_| AppError::new(ErrorCode::ConfigIo, None))?;
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
                current[index] = previous[index - 1]
                    && (token == '?' || token == value[index - 1]);
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

#[cfg(windows)]
fn enumerate_native_windows() -> Vec<NativeWindow> {
    use windows::{
        core::{BOOL, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM},
            Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
            System::Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
                PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::WindowsAndMessaging::{
                EnumWindows, GetClassNameW, GetDesktopWindow, GetShellWindow,
                GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
                GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
                WS_EX_TOOLWINDOW,
            },
        },
    };

    unsafe extern "system" fn collect(hwnd: HWND, raw: LPARAM) -> BOOL {
        let output = &mut *(raw.0 as *mut Vec<NativeWindow>);
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
        output.push(NativeWindow {
            identity: WindowIdentity {
                hwnd: hwnd.0 as isize,
                pid,
                process_started,
            },
            app_name,
            title: parsed_title,
            executable_name,
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
fn enumerate_native_windows() -> Vec<NativeWindow> {
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
    unsafe { PostMessageW(Some(HWND(identity.hwnd as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0)) }
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
}
