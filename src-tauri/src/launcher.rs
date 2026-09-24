//! ID-resolved launch orchestration. OS interaction is kept behind small mockable ports.
use crate::contracts::{
    AppError, EmptyResponse, ErrorCode, LaunchOutcome, LaunchResponse, MaterialItem, TargetType,
};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detection {
    Exact(isize),
    Estimated(isize),
    NotDetected,
    Unknown,
    NotTrackable,
}

pub trait WindowDetection: Send + Sync + 'static {
    fn detect(&self, material: &MaterialItem) -> Detection;
}
pub trait Foreground: Send + Sync + 'static {
    fn activate(&self, hwnd: isize) -> Result<(), ErrorCode>;
}
pub trait TargetLaunch: Send + Sync + 'static {
    fn launch(&self, material: &MaterialItem) -> Result<LaunchReport, ErrorCode>;
    fn reveal(&self, material: &MaterialItem) -> Result<(), ErrorCode>;
    fn launch_with_explorer_mode(
        &self,
        material: &MaterialItem,
        _mode: ExplorerOpenMode,
    ) -> Result<LaunchReport, ErrorCode> {
        self.launch(material)
    }
    fn reveal_with_explorer_mode(
        &self,
        material: &MaterialItem,
        _mode: ExplorerOpenMode,
    ) -> Result<(), ErrorCode> {
        self.reveal(material)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplorerOpenMode {
    #[default]
    NewWindow,
    ExistingTab,
}

/// Kept inside the launcher only.  It deliberately has no serde implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchReport {
    Tracked,
    NotTrackable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionEntry {
    material_id: crate::contracts::Id,
    pid: u32,
    hwnd: isize,
    process_started: u64,
    target_type: TargetType,
}

#[derive(Debug, Clone, Copy)]
struct SessionSnapshot {
    hwnd_exists: bool,
    window_pid: u32,
    process_alive: bool,
    process_pid: u32,
    process_started: u64,
    candidate_count: usize,
}

fn session_matches(entry: &SessionEntry, snapshot: SessionSnapshot) -> bool {
    snapshot.hwnd_exists
        && snapshot.window_pid == entry.pid
        && snapshot.process_alive
        && snapshot.process_pid == entry.pid
        && snapshot.process_started == entry.process_started
        && snapshot.candidate_count == 1
}

#[derive(Default)]
struct SessionState {
    entries: Vec<SessionEntry>,
}

type SharedSessionState = Arc<Mutex<SessionState>>;

fn replace_session(state: &SharedSessionState, entry: SessionEntry) {
    let mut state = state.lock().expect("launcher session state poisoned");
    state
        .entries
        .retain(|old| old.material_id != entry.material_id);
    state.entries.push(entry);
}

fn take_session(state: &SharedSessionState, material: &MaterialItem) -> Option<SessionEntry> {
    let state = state.lock().expect("launcher session state poisoned");
    state
        .entries
        .iter()
        .find(|entry| entry.material_id == material.id)
        .cloned()
}

fn discard_session(state: &SharedSessionState, material: &MaterialItem) {
    state
        .lock()
        .expect("launcher session state poisoned")
        .entries
        .retain(|entry| entry.material_id != material.id);
}

#[derive(Clone)]
pub struct Launcher<D, F, L> {
    detection: D,
    foreground: F,
    target: L,
}

impl<D: WindowDetection, F: Foreground, L: TargetLaunch> Launcher<D, F, L> {
    pub fn new(detection: D, foreground: F, target: L) -> Self {
        Self {
            detection,
            foreground,
            target,
        }
    }

    pub fn activate_or_launch(&self, material: MaterialItem) -> LaunchResponse {
        self.activate_or_launch_with_explorer_mode(material, ExplorerOpenMode::NewWindow)
    }

    pub fn activate_or_launch_with_explorer_mode(
        &self,
        material: MaterialItem,
        explorer_mode: ExplorerOpenMode,
    ) -> LaunchResponse {
        let id = material.id.clone();
        let failure = |outcome, code| LaunchResponse {
            material_id: id.clone(),
            outcome,
            error: Some(AppError::new(code, Some(id.clone()))),
        };
        if material.target_type == TargetType::Url {
            return match self.target.launch(&material) {
                Ok(_) => LaunchResponse {
                    material_id: id,
                    outcome: LaunchOutcome::NotTrackable,
                    error: None,
                },
                Err(code) => failure(LaunchOutcome::Failed, code),
            };
        }
        if material.target_type == TargetType::Folder {
            return match self
                .target
                .launch_with_explorer_mode(&material, explorer_mode)
            {
                Ok(_) => LaunchResponse {
                    material_id: id,
                    outcome: LaunchOutcome::Launched,
                    error: None,
                },
                Err(ErrorCode::NotFound) => failure(LaunchOutcome::NotFound, ErrorCode::NotFound),
                Err(code) => failure(LaunchOutcome::Failed, code),
            };
        }
        match self.detection.detect(&material) {
            Detection::Exact(hwnd) | Detection::Estimated(hwnd) => {
                match self.foreground.activate(hwnd) {
                    Ok(()) => LaunchResponse {
                        material_id: id,
                        outcome: LaunchOutcome::Activated,
                        error: None,
                    },
                    Err(ErrorCode::ForegroundDenied) => {
                        failure(LaunchOutcome::ForegroundDenied, ErrorCode::ForegroundDenied)
                    }
                    Err(ErrorCode::WindowNotFound) => {
                        failure(LaunchOutcome::NotFound, ErrorCode::WindowNotFound)
                    }
                    Err(code) => failure(LaunchOutcome::Failed, code),
                }
            }
            Detection::Unknown => failure(LaunchOutcome::Failed, ErrorCode::WindowNotFound),
            Detection::NotDetected | Detection::NotTrackable => match self
                .target
                .launch_with_explorer_mode(&material, explorer_mode)
            {
                Ok(_) => LaunchResponse {
                    material_id: id,
                    outcome: LaunchOutcome::Launched,
                    error: None,
                },
                Err(ErrorCode::NotFound) => failure(LaunchOutcome::NotFound, ErrorCode::NotFound),
                Err(code) => failure(LaunchOutcome::Failed, code),
            },
        }
    }

    pub fn reveal(&self, material: MaterialItem) -> Result<EmptyResponse, AppError> {
        self.reveal_with_explorer_mode(material, ExplorerOpenMode::NewWindow)
    }

    pub fn reveal_with_explorer_mode(
        &self,
        material: MaterialItem,
        explorer_mode: ExplorerOpenMode,
    ) -> Result<EmptyResponse, AppError> {
        if material.target_type == TargetType::Url {
            return Err(AppError::new(
                ErrorCode::UnsupportedTarget,
                Some(material.id),
            ));
        }
        self.target
            .reveal_with_explorer_mode(&material, explorer_mode)
            .map_err(|code| AppError::new(code, Some(material.id)))?;
        Ok(EmptyResponse {})
    }
}

#[derive(Clone)]
pub struct NativeWindowDetection {
    state: SharedSessionState,
}
fn normalized_title(value: &str) -> String {
    value
        .replace('\0', "")
        .split_ascii_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase()
}
fn title_matches(title: &str, material: &MaterialItem) -> bool {
    let title = normalized_title(title);
    let filename = Path::new(&material.path)
        .file_name()
        .and_then(|v| v.to_str())
        .map(normalized_title)
        .unwrap_or_default();
    let hint = material
        .window_match_pattern
        .as_deref()
        .map(normalized_title)
        .unwrap_or_default();
    (!filename.is_empty() && title.contains(&filename))
        || (!hint.is_empty() && title.contains(&hint))
}

#[cfg(windows)]
impl WindowDetection for NativeWindowDetection {
    fn detect(&self, material: &MaterialItem) -> Detection {
        use windows::{
            core::BOOL,
            Win32::{
                Foundation::{HWND, LPARAM},
                UI::WindowsAndMessaging::{
                    EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindow, IsWindowVisible,
                },
            },
        };
        unsafe extern "system" fn collect(hwnd: HWND, raw: LPARAM) -> BOOL {
            if !IsWindowVisible(hwnd).as_bool() {
                return true.into();
            }
            let length = GetWindowTextLengthW(hwnd);
            if length <= 0 {
                return true.into();
            }
            let mut text = vec![0u16; length as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut text);
            if copied > 0 {
                let output = &mut *(raw.0 as *mut Vec<(isize, String)>);
                output.push((
                    hwnd.0 as isize,
                    String::from_utf16_lossy(&text[..copied as usize]),
                ));
            }
            true.into()
        }
        if let Some(entry) = take_session(&self.state, material) {
            if let Some(hwnd) = validate_session(&entry) {
                return Detection::Exact(hwnd);
            }
            // A dead window/process, a different PID, or a changed creation time is never
            // allowed to fall through to title matching: that could activate another app.
            discard_session(&self.state, material);
            return Detection::NotTrackable;
        }
        let mut entries: Vec<(isize, String)> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut entries as *mut _ as isize));
        }
        let mut matches: Vec<_> = entries
            .into_iter()
            .filter(|(_, title)| title_matches(title, material))
            .map(|(hwnd, _)| hwnd)
            .collect();
        matches.sort_unstable();
        matches.dedup();
        match matches.as_slice() {
            [] => Detection::NotDetected,
            [hwnd] => unsafe {
                if IsWindow(Some(windows::Win32::Foundation::HWND(*hwnd as *mut _))).as_bool() {
                    Detection::Estimated(*hwnd)
                } else {
                    Detection::Unknown
                }
            },
            _ => Detection::Unknown,
        }
    }
}

#[cfg(windows)]
fn process_started(handle: windows::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};
    unsafe {
        let mut created = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user)
            .ok()
            .map(|_| ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}

#[cfg(windows)]
fn validate_session(entry: &SessionEntry) -> Option<isize> {
    use windows::Win32::{
        Foundation::HWND,
        System::Threading::{GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
    };
    let hwnd = HWND(entry.hwnd as *mut _);
    unsafe {
        let hwnd_exists = IsWindow(Some(hwnd)).as_bool();
        let window_pid = GetWindowThreadProcessId(hwnd, None);
        if !hwnd_exists || window_pid != entry.pid {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.pid).ok()?;
        struct Handle(windows::Win32::Foundation::HANDLE);
        impl Drop for Handle {
            fn drop(&mut self) {
                unsafe {
                    let _ = windows::Win32::Foundation::CloseHandle(self.0);
                }
            }
        }
        let handle = Handle(handle);
        let process_pid = GetProcessId(handle.0);
        let Some(process_started) = process_started(handle.0) else {
            return None;
        };
        let mut exit_code = 0;
        let process_alive = windows::Win32::System::Threading::GetExitCodeProcess(handle.0, &mut exit_code).is_ok()
            // STILL_ACTIVE is the Win32-defined exit code (259).
            && exit_code == 259;
        if !session_matches(
            entry,
            SessionSnapshot {
                hwnd_exists,
                window_pid,
                process_alive,
                process_pid,
                process_started,
                candidate_count: 1,
            },
        ) {
            return None;
        }
        Some(entry.hwnd)
    }
}

#[derive(Clone, Copy, Default)]
pub struct NativeForeground;
#[cfg(windows)]
impl Foreground for NativeForeground {
    fn activate(&self, raw: isize) -> Result<(), ErrorCode> {
        use windows::Win32::{
            Foundation::HWND,
            System::Threading::{AttachThreadInput, GetCurrentThreadId},
            UI::WindowsAndMessaging::{
                FlashWindow, GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow,
                ShowWindow, SW_RESTORE,
            },
        };
        let hwnd = HWND(raw as *mut _);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return Err(ErrorCode::WindowNotFound);
            }
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let target = GetWindowThreadProcessId(hwnd, None);
            if target == 0 {
                return Err(ErrorCode::WindowNotFound);
            }
            let current = GetCurrentThreadId();
            struct Guard {
                current: u32,
                target: u32,
                attached: bool,
            }
            impl Drop for Guard {
                fn drop(&mut self) {
                    if self.attached {
                        unsafe {
                            let _ = AttachThreadInput(self.current, self.target, false);
                        }
                    }
                }
            }
            let guard = Guard {
                current,
                target,
                attached: current != target && AttachThreadInput(current, target, true).as_bool(),
            };
            if !IsWindow(Some(hwnd)).as_bool() {
                return Err(ErrorCode::WindowNotFound);
            }
            let ok = SetForegroundWindow(hwnd).as_bool();
            drop(guard);
            if !ok {
                let _ = FlashWindow(hwnd, true);
                return Err(ErrorCode::ForegroundDenied);
            }
            Ok(())
        }
    }
}

#[derive(Clone)]
pub struct NativeTargetLaunch {
    state: SharedSessionState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExplorerWindowObservation {
    hwnd: isize,
    class_name: String,
    folder_path: Option<String>,
}

fn normalize_explorer_path(path: &str) -> String {
    let mut normalized = path.trim().replace('/', "\\");
    while normalized.len() > 3 && normalized.ends_with('\\') {
        normalized.pop();
    }
    normalized.to_lowercase()
}

fn matching_explorer_window(
    requested_path: &str,
    windows: &[ExplorerWindowObservation],
) -> Option<isize> {
    let requested = normalize_explorer_path(requested_path);
    if requested.is_empty() {
        return None;
    }
    let mut matches = windows.iter().filter(|window| {
        matches!(
            window.class_name.as_str(),
            "CabinetWClass" | "ExploreWClass"
        ) && window
            .folder_path
            .as_deref()
            .map(normalize_explorer_path)
            .is_some_and(|path| path == requested)
    });
    let hwnd = matches.next()?.hwnd;
    matches.next().is_none().then_some(hwnd)
}

#[cfg(windows)]
fn existing_explorer_window(_requested_path: &str) -> Option<isize> {
    // EnumWindows can establish that a window is Explorer, but it cannot safely expose
    // the active tab's filesystem path. Until that path is available from a supported
    // shell API, do not guess from the title; let Explorer perform the normal open.
    matching_explorer_window(_requested_path, &[])
}

#[cfg(windows)]
impl TargetLaunch for NativeTargetLaunch {
    fn launch(&self, material: &MaterialItem) -> Result<LaunchReport, ErrorCode> {
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::CloseHandle,
                System::Threading::GetProcessId,
                UI::{
                    Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
                    WindowsAndMessaging::SW_SHOWNORMAL,
                },
            },
        };
        let shell_path = crate::contracts::windows_shell_path(&material.path);
        let target: Vec<u16> = shell_path.encode_utf16().chain(Some(0)).collect();
        let mut execute = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpFile: PCWSTR(target.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        if unsafe { ShellExecuteExW(&mut execute) }.is_err() {
            Err(ErrorCode::LaunchFailed)
        } else {
            struct ProcessHandle(windows::Win32::Foundation::HANDLE);
            impl Drop for ProcessHandle {
                fn drop(&mut self) {
                    unsafe {
                        let _ = CloseHandle(self.0);
                    }
                }
            }
            if execute.hProcess.is_invalid() {
                return Ok(LaunchReport::NotTrackable);
            }
            let handle = ProcessHandle(execute.hProcess);
            if material.target_type == TargetType::Url {
                return Ok(LaunchReport::NotTrackable);
            }
            let pid = unsafe { GetProcessId(handle.0) };
            let Some(started) = process_started(handle.0) else {
                return Ok(LaunchReport::NotTrackable);
            };
            let Some(hwnd) = find_single_window_for_pid(pid) else {
                return Ok(LaunchReport::NotTrackable);
            };
            replace_session(
                &self.state,
                SessionEntry {
                    material_id: material.id.clone(),
                    pid,
                    hwnd,
                    process_started: started,
                    target_type: material.target_type,
                },
            );
            Ok(LaunchReport::Tracked)
        }
    }
    fn reveal(&self, material: &MaterialItem) -> Result<(), ErrorCode> {
        self.reveal_with_explorer_mode(material, ExplorerOpenMode::NewWindow)
    }
    fn launch_with_explorer_mode(
        &self,
        material: &MaterialItem,
        mode: ExplorerOpenMode,
    ) -> Result<LaunchReport, ErrorCode> {
        if material.target_type != TargetType::Folder {
            return self.launch(material);
        }
        self.open_in_explorer(material, mode, false)?;
        Ok(LaunchReport::NotTrackable)
    }
    fn reveal_with_explorer_mode(
        &self,
        material: &MaterialItem,
        mode: ExplorerOpenMode,
    ) -> Result<(), ErrorCode> {
        self.open_in_explorer(material, mode, material.target_type != TargetType::Folder)
    }
}

#[cfg(windows)]
impl NativeTargetLaunch {
    fn open_in_explorer(
        &self,
        material: &MaterialItem,
        mode: ExplorerOpenMode,
        select_file: bool,
    ) -> Result<(), ErrorCode> {
        let shell_path = crate::contracts::windows_shell_path(&material.path);
        let path = Path::new(&shell_path);
        let folder_path = if select_file {
            path.parent().and_then(Path::to_str).unwrap_or(&shell_path)
        } else {
            &shell_path
        };
        if mode == ExplorerOpenMode::ExistingTab {
            if let Some(hwnd) = existing_explorer_window(folder_path) {
                NativeForeground.activate(hwnd)?;
                return Ok(());
            }
        }
        let argument = if select_file {
            format!("/select,{shell_path}")
        } else if mode == ExplorerOpenMode::NewWindow {
            format!("/n,{shell_path}")
        } else {
            shell_path.clone()
        };
        std::process::Command::new("explorer.exe")
            .arg(argument)
            .spawn()
            .map(|_| ())
            .map_err(|_| {
                if path.exists() {
                    ErrorCode::LaunchFailed
                } else {
                    ErrorCode::NotFound
                }
            })
    }
}

#[cfg(windows)]
fn find_single_window_for_pid(pid: u32) -> Option<isize> {
    use windows::{
        core::BOOL,
        Win32::{
            Foundation::{HWND, LPARAM},
            UI::WindowsAndMessaging::{
                EnumWindows, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
            },
        },
    };
    unsafe extern "system" fn collect(hwnd: HWND, raw: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() && GetWindowThreadProcessId(hwnd, None) != 0 {
            let entries = &mut *(raw.0 as *mut Vec<(isize, u32)>);
            entries.push((hwnd.0 as isize, GetWindowThreadProcessId(hwnd, None)));
        }
        true.into()
    }
    for _ in 0..6 {
        let mut entries: Vec<(isize, u32)> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut entries as *mut _ as isize));
        }
        let mut matches: Vec<_> = entries
            .into_iter()
            .filter_map(|(hwnd, owner)| (owner == pid).then_some(hwnd))
            .collect();
        matches.sort_unstable();
        matches.dedup();
        if let [hwnd] = matches.as_slice() {
            if unsafe { IsWindow(Some(HWND(*hwnd as *mut _))).as_bool() } {
                return Some(*hwnd);
            }
        }
        if matches.len() > 1 {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    None
}

pub type NativeLauncher = Launcher<NativeWindowDetection, NativeForeground, NativeTargetLaunch>;
impl Default for NativeLauncher {
    fn default() -> Self {
        let state = Arc::new(Mutex::new(SessionState::default()));
        Self::new(
            NativeWindowDetection {
                state: state.clone(),
            },
            NativeForeground,
            NativeTargetLaunch { state },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{Id, MaterialRole};
    use std::sync::{Arc, Mutex};
    #[derive(Clone)]
    struct Detect(Detection);
    impl WindowDetection for Detect {
        fn detect(&self, _: &MaterialItem) -> Detection {
            self.0
        }
    }
    #[derive(Clone)]
    struct Front(Result<(), ErrorCode>);
    impl Foreground for Front {
        fn activate(&self, _: isize) -> Result<(), ErrorCode> {
            self.0
        }
    }
    #[derive(Clone)]
    struct Launch {
        calls: Arc<Mutex<Vec<String>>>,
        result: Result<LaunchReport, ErrorCode>,
    }
    impl TargetLaunch for Launch {
        fn launch(&self, m: &MaterialItem) -> Result<LaunchReport, ErrorCode> {
            self.calls.lock().unwrap().push(m.id.as_str().into());
            self.result
        }
        fn reveal(&self, _: &MaterialItem) -> Result<(), ErrorCode> {
            self.result.map(|_| ())
        }
    }
    fn item(id: &str, kind: TargetType) -> MaterialItem {
        MaterialItem {
            id: Id::try_from(id.to_owned()).unwrap(),
            group_id: Id::try_from("g1".to_owned()).unwrap(),
            name: id.into(),
            role: MaterialRole::Main,
            target_type: kind,
            path: if kind == TargetType::Url {
                "https://example.test/a?secret=1".into()
            } else {
                "C:\\Docs\\a[1].txt".into()
            },
            window_match_pattern: Some("a[1]".into()),
            order: 1,
        }
    }
    #[test]
    fn win04_literal_hint_is_data_and_ambiguous_detection_never_launches_or_activates() {
        let m = item("m1", TargetType::File);
        assert!(title_matches("  A[1].TXT   - editor ", &m));
        assert!(!title_matches("a111txt - editor", &m));
        let calls = Arc::new(Mutex::new(vec![]));
        let l = Launcher::new(
            Detect(Detection::Unknown),
            Front(Ok(())),
            Launch {
                calls: calls.clone(),
                result: Ok(LaunchReport::NotTrackable),
            },
        );
        let r = l.activate_or_launch(item("m1", TargetType::File));
        assert_eq!(r.outcome, LaunchOutcome::Failed);
        assert!(calls.lock().unwrap().is_empty());
    }
    #[test]
    fn win05_https_is_launched_as_not_trackable() {
        let calls = Arc::new(Mutex::new(vec![]));
        let l = Launcher::new(
            Detect(Detection::Exact(1)),
            Front(Ok(())),
            Launch {
                calls: calls.clone(),
                result: Ok(LaunchReport::NotTrackable),
            },
        );
        let r = l.activate_or_launch(item("m1", TargetType::Url));
        assert_eq!(r.outcome, LaunchOutcome::NotTrackable);
        assert_eq!(&*calls.lock().unwrap(), &["m1"]);
    }
    #[test]
    fn foreground_refusal_is_not_success_and_error_is_sanitized() {
        let l = Launcher::new(
            Detect(Detection::Exact(1)),
            Front(Err(ErrorCode::ForegroundDenied)),
            Launch {
                calls: Default::default(),
                result: Ok(LaunchReport::NotTrackable),
            },
        );
        let r = l.activate_or_launch(item("m1", TargetType::File));
        assert_eq!(r.outcome, LaunchOutcome::ForegroundDenied);
        assert!(!r.error.unwrap().message.contains("C:\\"));
    }

    #[test]
    fn win06_failure_does_not_stop_later_materials() {
        #[derive(Clone)]
        struct Selective(Arc<Mutex<Vec<String>>>);
        impl TargetLaunch for Selective {
            fn launch(&self, m: &MaterialItem) -> Result<LaunchReport, ErrorCode> {
                self.0.lock().unwrap().push(m.id.as_str().into());
                if m.id.as_str() == "m1" {
                    Err(ErrorCode::LaunchFailed)
                } else {
                    Ok(LaunchReport::NotTrackable)
                }
            }
            fn reveal(&self, _: &MaterialItem) -> Result<(), ErrorCode> {
                Ok(())
            }
        }
        let calls = Arc::new(Mutex::new(vec![]));
        let service = Launcher::new(
            Detect(Detection::NotDetected),
            Front(Ok(())),
            Selective(calls.clone()),
        );
        let results = [item("m1", TargetType::File), item("m2", TargetType::File)]
            .into_iter()
            .map(|m| service.activate_or_launch(m))
            .collect::<Vec<_>>();
        assert_eq!(results[0].outcome, LaunchOutcome::Failed);
        assert_eq!(results[1].outcome, LaunchOutcome::Launched);
        assert_eq!(&*calls.lock().unwrap(), &["m1", "m2"]);
    }

    fn session() -> SessionEntry {
        SessionEntry {
            material_id: Id::try_from("m1".to_owned()).unwrap(),
            pid: 42,
            hwnd: 101,
            process_started: 77,
            target_type: TargetType::File,
        }
    }
    fn snapshot() -> SessionSnapshot {
        SessionSnapshot {
            hwnd_exists: true,
            window_pid: 42,
            process_alive: true,
            process_pid: 42,
            process_started: 77,
            candidate_count: 1,
        }
    }

    #[test]
    fn session_validation_rejects_each_unsafe_observation() {
        let entry = session();
        assert!(session_matches(&entry, snapshot())); // PID/HWND PID match
        let mut mismatch = snapshot();
        mismatch.window_pid = 7;
        assert!(!session_matches(&entry, mismatch)); // PID mismatch / delegated child
        let mut no_hwnd = snapshot();
        no_hwnd.hwnd_exists = false;
        assert!(!session_matches(&entry, no_hwnd)); // no HWND or disappeared HWND
        let mut many = snapshot();
        many.candidate_count = 2;
        assert!(!session_matches(&entry, many)); // ambiguous windows
        let mut exited = snapshot();
        exited.process_alive = false;
        assert!(!session_matches(&entry, exited)); // process exit
        let mut reused = snapshot();
        reused.process_started = 78;
        assert!(!session_matches(&entry, reused)); // PID reuse suspicion
        let mut delegated = snapshot();
        delegated.process_pid = 0;
        assert!(!session_matches(&entry, delegated)); // Explorer/no process identity
    }

    #[test]
    fn native_launcher_clones_share_only_in_memory_session_state() {
        let launcher = NativeLauncher::default();
        let clone = launcher.clone();
        let material = item("m1", TargetType::File);
        replace_session(&launcher.detection.state, session());
        assert_eq!(
            take_session(&clone.detection.state, &material),
            Some(session())
        );
    }

    #[test]
    fn session_identifiers_do_not_leak_to_persisted_or_ipc_dtos() {
        let material_json = serde_json::to_value(item("m1", TargetType::File)).unwrap();
        assert!(material_json.get("pid").is_none());
        assert!(material_json.get("hwnd").is_none());
        let response = Launcher::new(
            Detect(Detection::NotDetected),
            Front(Ok(())),
            Launch {
                calls: Default::default(),
                result: Ok(LaunchReport::Tracked),
            },
        )
        .activate_or_launch(item("m1", TargetType::File));
        let response_json = serde_json::to_value(response).unwrap();
        assert!(response_json.get("pid").is_none());
        assert!(response_json.get("hwnd").is_none());
    }

    #[test]
    fn explorer_mode_uses_stable_snake_case_values_and_defaults_to_new_window() {
        assert_eq!(ExplorerOpenMode::default(), ExplorerOpenMode::NewWindow);
        assert_eq!(
            serde_json::to_value(ExplorerOpenMode::NewWindow).unwrap(),
            "new_window"
        );
        assert_eq!(
            serde_json::from_str::<ExplorerOpenMode>("\"existing_tab\"").unwrap(),
            ExplorerOpenMode::ExistingTab
        );
    }

    #[test]
    fn explorer_window_matching_requires_real_path_and_explorer_class() {
        let windows = vec![
            ExplorerWindowObservation {
                hwnd: 10,
                class_name: "NotExplorer".into(),
                folder_path: Some("C:\\Meetings\\Current".into()),
            },
            ExplorerWindowObservation {
                hwnd: 20,
                class_name: "CabinetWClass".into(),
                folder_path: None,
            },
            ExplorerWindowObservation {
                hwnd: 30,
                class_name: "CabinetWClass".into(),
                folder_path: Some("c:/meetings/current/".into()),
            },
        ];
        assert_eq!(
            matching_explorer_window("C:\\MEETINGS\\Current", &windows),
            Some(30)
        );
        assert_eq!(
            matching_explorer_window("C:\\Meetings\\Other", &windows),
            None
        );
    }

    #[test]
    fn explorer_window_matching_rejects_ambiguous_exact_paths() {
        let windows = [41, 42].map(|hwnd| ExplorerWindowObservation {
            hwnd,
            class_name: "CabinetWClass".into(),
            folder_path: Some("C:\\Meetings".into()),
        });
        assert_eq!(matching_explorer_window("c:/meetings/", &windows), None);
    }

    #[test]
    fn folder_launch_receives_requested_mode_while_legacy_api_keeps_new_window() {
        #[derive(Clone, Default)]
        struct ModeLaunch(Arc<Mutex<Vec<ExplorerOpenMode>>>);
        impl TargetLaunch for ModeLaunch {
            fn launch(&self, _: &MaterialItem) -> Result<LaunchReport, ErrorCode> {
                Ok(LaunchReport::NotTrackable)
            }
            fn reveal(&self, _: &MaterialItem) -> Result<(), ErrorCode> {
                Ok(())
            }
            fn launch_with_explorer_mode(
                &self,
                _: &MaterialItem,
                mode: ExplorerOpenMode,
            ) -> Result<LaunchReport, ErrorCode> {
                self.0.lock().unwrap().push(mode);
                Ok(LaunchReport::NotTrackable)
            }
        }
        let target = ModeLaunch::default();
        let service = Launcher::new(Detect(Detection::Exact(99)), Front(Ok(())), target.clone());
        service.activate_or_launch(item("folder-1", TargetType::Folder));
        service.activate_or_launch_with_explorer_mode(
            item("folder-2", TargetType::Folder),
            ExplorerOpenMode::ExistingTab,
        );
        assert_eq!(
            &*target.0.lock().unwrap(),
            &[ExplorerOpenMode::NewWindow, ExplorerOpenMode::ExistingTab]
        );
    }
}
