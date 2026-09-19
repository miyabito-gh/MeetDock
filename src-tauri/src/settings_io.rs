//! Settings-only filesystem boundary. No material path or UNC probing.
use crate::contracts::{AppError, ErrorCode, UtcTimestamp};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    ReadCurrent,
    Discover,
    ReadCandidate,
    CreateDirectory,
    TempWrite,
    TempSync,
    TempVerify,
    BackupWrite,
    BackupSync,
    BackupVerify,
    RotateThree,
    RotateTwo,
    RotateOne,
    BeforeCommit,
    Replace,
    FirstMove,
    Committed,
    Cleanup,
}

/// Tests wrap this port to fail, partially write, or pause at a specific stage.
/// A checkpoint never receives configuration contents or paths.
pub trait FileOps: Send + Sync + 'static {
    fn checkpoint(&self, _stage: Stage) -> io::Result<()> {
        Ok(())
    }
    fn read(&self, path: &Path) -> io::Result<Option<Vec<u8>>>;
    fn list(&self, directory: &Path) -> io::Result<Vec<PathBuf>>;
    fn create_directory(&self, directory: &Path) -> io::Result<()>;
    fn write(&self, path: &Path, bytes: &[u8], exclusive: bool) -> io::Result<()>;
    fn sync(&self, path: &Path) -> io::Result<()>;
    fn move_file(&self, from: &Path, to: &Path, replace: bool) -> io::Result<()>;
    fn replace(&self, current: &Path, temp: &Path, displaced: &Path) -> io::Result<()>;
    fn remove(&self, path: &Path) -> io::Result<()>;
}

#[derive(Default)]
pub struct NativeFileOps;
impl FileOps for NativeFileOps {
    fn read(&self, path: &Path) -> io::Result<Option<Vec<u8>>> {
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
            Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
                Err(io::ErrorKind::InvalidData.into())
            }
            Ok(_) => fs::read(path).map(Some),
        }
    }
    fn list(&self, directory: &Path) -> io::Result<Vec<PathBuf>> {
        match fs::read_dir(directory) {
            Ok(entries) => entries.map(|e| e.map(|e| e.path())).collect(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e),
        }
    }
    fn create_directory(&self, directory: &Path) -> io::Result<()> {
        fs::create_dir_all(directory)
    }
    fn write(&self, path: &Path, bytes: &[u8], exclusive: bool) -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true);
        if exclusive {
            options.create_new(true);
        } else {
            options.create(true).truncate(true);
        }
        options.open(path)?.write_all(bytes)
    }
    fn sync(&self, path: &Path) -> io::Result<()> {
        fs::OpenOptions::new().write(true).open(path)?.sync_all()
    }
    fn move_file(&self, from: &Path, to: &Path, replace: bool) -> io::Result<()> {
        native_move(from, to, replace)
    }
    fn replace(&self, current: &Path, temp: &Path, displaced: &Path) -> io::Result<()> {
        native_replace(current, temp, displaced)
    }
    fn remove(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

#[cfg(windows)]
fn wide(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    value.push(0);
    Ok(value)
}
#[cfg(windows)]
fn native_move(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::*};
    let (from, to) = (wide(from)?, wide(to)?);
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            MOVE_FILE_FLAGS(0)
        };
    // Buffers remain live throughout the call. No cross-volume copy fallback.
    unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), flags) }
        .map_err(|_| io::Error::last_os_error())
}
#[cfg(windows)]
fn native_replace(current: &Path, temp: &Path, displaced: &Path) -> io::Result<()> {
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::*};
    let (current, temp, displaced) = (wide(current)?, wide(temp)?, wide(displaced)?);
    // Explicit backup preserves the old bytes even on ERROR_UNABLE_TO_MOVE_REPLACEMENT_2.
    // REPLACEFILE_WRITE_THROUGH is unsupported; temp and bak.new were synced beforehand.
    unsafe {
        ReplaceFileW(
            PCWSTR(current.as_ptr()),
            PCWSTR(temp.as_ptr()),
            PCWSTR(displaced.as_ptr()),
            REPLACE_FILE_FLAGS(0),
            None,
            None,
        )
    }
    .map_err(|_| io::Error::last_os_error())
}
#[cfg(not(windows))]
fn native_move(_: &Path, _: &Path, _: bool) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}
#[cfg(not(windows))]
fn native_replace(_: &Path, _: &Path, _: &Path) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

pub fn token() -> Result<String, AppError> {
    #[cfg(windows)]
    {
        unsafe { windows::Win32::System::Com::CoCreateGuid() }
            .map(|guid| format!("{:032x}", guid.to_u128()))
            .map_err(|_| AppError::new(ErrorCode::InternalError, None))
    }
    #[cfg(not(windows))]
    {
        Err(AppError::new(ErrorCode::InternalError, None))
    }
}
pub fn now() -> Result<UtcTimestamp, AppError> {
    #[cfg(windows)]
    {
        let t = unsafe { windows::Win32::System::SystemInformation::GetSystemTime() };
        UtcTimestamp::try_from(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
        ))
        .map_err(|_| AppError::new(ErrorCode::InternalError, None))
    }
    #[cfg(not(windows))]
    {
        Err(AppError::new(ErrorCode::InternalError, None))
    }
}
