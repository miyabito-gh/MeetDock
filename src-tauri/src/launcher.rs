//! ID-resolved launch orchestration. OS interaction is kept behind small mockable ports.
use crate::contracts::{
    AppError, EmptyResponse, ErrorCode, LaunchOutcome, LaunchResponse, MaterialItem, TargetType,
};
use std::path::Path;

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
    fn launch(&self, material: &MaterialItem) -> Result<(), ErrorCode>;
    fn reveal(&self, material: &MaterialItem) -> Result<(), ErrorCode>;
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
        let id = material.id.clone();
        let failure = |outcome, code| LaunchResponse {
            material_id: id.clone(),
            outcome,
            error: Some(AppError::new(code, Some(id.clone()))),
        };
        if material.target_type == TargetType::Url {
            return match self.target.launch(&material) {
                Ok(()) => LaunchResponse {
                    material_id: id,
                    outcome: LaunchOutcome::NotTrackable,
                    error: None,
                },
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
            Detection::NotDetected | Detection::NotTrackable => match self.target.launch(&material)
            {
                Ok(()) => LaunchResponse {
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
        if material.target_type == TargetType::Url {
            return Err(AppError::new(
                ErrorCode::UnsupportedTarget,
                Some(material.id),
            ));
        }
        self.target
            .reveal(&material)
            .map_err(|code| AppError::new(code, Some(material.id)))?;
        Ok(EmptyResponse {})
    }
}

#[derive(Clone, Copy, Default)]
pub struct NativeWindowDetection;
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

#[derive(Clone, Copy, Default)]
pub struct NativeTargetLaunch;
#[cfg(windows)]
impl TargetLaunch for NativeTargetLaunch {
    fn launch(&self, material: &MaterialItem) -> Result<(), ErrorCode> {
        use windows::{
            core::PCWSTR,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };
        let shell_path = crate::contracts::windows_shell_path(&material.path);
        let target: Vec<u16> = shell_path.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR::null(),
                PCWSTR(target.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            Err(ErrorCode::LaunchFailed)
        } else {
            Ok(())
        }
    }
    fn reveal(&self, material: &MaterialItem) -> Result<(), ErrorCode> {
        let shell_path = crate::contracts::windows_shell_path(&material.path);
        let path = Path::new(&shell_path);
        let argument = if material.target_type == TargetType::Folder {
            shell_path.clone()
        } else {
            format!("/select,{shell_path}")
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

pub type NativeLauncher = Launcher<NativeWindowDetection, NativeForeground, NativeTargetLaunch>;
impl Default for NativeLauncher {
    fn default() -> Self {
        Self::new(NativeWindowDetection, NativeForeground, NativeTargetLaunch)
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
        result: Result<(), ErrorCode>,
    }
    impl TargetLaunch for Launch {
        fn launch(&self, m: &MaterialItem) -> Result<(), ErrorCode> {
            self.calls.lock().unwrap().push(m.id.as_str().into());
            self.result
        }
        fn reveal(&self, _: &MaterialItem) -> Result<(), ErrorCode> {
            self.result
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
                result: Ok(()),
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
                result: Ok(()),
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
                result: Ok(()),
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
            fn launch(&self, m: &MaterialItem) -> Result<(), ErrorCode> {
                self.0.lock().unwrap().push(m.id.as_str().into());
                if m.id.as_str() == "m1" {
                    Err(ErrorCode::LaunchFailed)
                } else {
                    Ok(())
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
}
