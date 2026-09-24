//! Pure IPC types. Command boundaries must use `decode` (or `Validate::validate`)
//! before using a DTO; execution ports resolve IDs from saved configuration.
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
macro_rules! enumeration {
    ($name:ident { $($variant:ident),+ }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
    };
}
enumeration!(MaterialRole { Main, Reference });
enumeration!(TargetType { File, Folder, Url });
enumeration!(SettingsMode {
    Ready,
    MigrationRequired,
    RecoveryRequired,
    ReadOnlyFutureSchema,
    ReadOnlyUnavailable
});
enumeration!(CandidateKind {
    Backup,
    Legacy,
    Temporary
});
enumeration!(ResolveAction {
    RestoreCandidate,
    ImportLegacy,
    InitializeEmpty,
    OpenReadOnly
});
enumeration!(OpenState {
    Open,
    NotDetected,
    Unknown,
    NotTrackable
});
enumeration!(Confidence {
    Exact,
    Estimated,
    Unknown
});
enumeration!(PathState {
    Exists,
    Missing,
    Timeout,
    AccessDenied,
    Unchecked,
    Error
});
enumeration!(LaunchOutcome {
    Activated,
    Launched,
    NotTrackable,
    ForegroundDenied,
    NotFound,
    Failed
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidRequest,
    ValidationError,
    ConfigConflict,
    ConfigCorrupt,
    ConfigIo,
    ReadOnlySchema,
    NotFound,
    AccessDenied,
    PathTimeout,
    PathQueueBusy,
    UnsupportedTarget,
    WindowNotFound,
    ForegroundDenied,
    LaunchFailed,
    PdfRangeInvalid,
    PdfNotAllowed,
    PdfNotReadable,
    PdfPasswordRequired,
    PdfCorrupt,
    PdfFallbackTooLarge,
    InternalError,
}
impl ErrorCode {
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::ConfigIo
                | Self::PathTimeout
                | Self::PathQueueBusy
                | Self::WindowNotFound
                | Self::LaunchFailed
        )
    }
}

macro_rules! string_type {
    ($name:ident, $check:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl TryFrom<String> for $name {
            type Error = &'static str;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                if $check(&value) {
                    Ok(Self(value))
                } else {
                    Err("invalid contract value")
                }
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}
fn valid_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn valid_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            14 => c == b'4',
            19 => matches!(c, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => c.is_ascii_hexdigit(),
        })
}
fn valid_timestamp(s: &str) -> bool {
    if !s.is_ascii() || s.len() < 20 {
        return false;
    }
    let b = s.as_bytes();
    if b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return false;
    }
    let parts: Option<Vec<u32>> = [(0, 4), (5, 7), (8, 10), (11, 13), (14, 16), (17, 19)]
        .iter()
        .map(|&(a, z)| {
            if b[a..z].iter().all(u8::is_ascii_digit) {
                s[a..z].parse().ok()
            } else {
                None
            }
        })
        .collect();
    let Some(p) = parts else {
        return false;
    };
    let (y, m, d, h, mi, se) = (p[0], p[1], p[2], p[3], p[4], p[5]);
    let days = [
        31,
        if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            29
        } else {
            28
        },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&m) || d == 0 || d > days[m as usize - 1] || h > 23 || mi > 59 {
        return false;
    }
    if se > 59
        && !(se == 60 && h == 23 && mi == 59 && matches!(m, 6 | 12) && d == days[m as usize - 1])
    {
        return false;
    }
    let tail = &s[19..];
    let fraction = if let Some(t) = tail.strip_suffix(['Z', 'z']) {
        t
    } else if let Some(t) = tail.strip_suffix("+00:00") {
        t
    } else {
        return false;
    };
    fraction.is_empty()
        || (fraction.starts_with('.')
            && fraction.len() > 1
            && fraction[1..].bytes().all(|c| c.is_ascii_digit()))
}
string_type!(Id, valid_id);
string_type!(RequestId, valid_uuid);
string_type!(UtcTimestamp, valid_timestamp);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct Revision(u64);
impl Revision {
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn next(self) -> Result<Self, AppError> {
        self.0
            .checked_add(1)
            .and_then(|v| Self::try_from(v).ok())
            .ok_or_else(|| AppError::new(ErrorCode::ValidationError, None))
    }
}
impl TryFrom<u64> for Revision {
    type Error = &'static str;
    fn try_from(v: u64) -> Result<Self, Self::Error> {
        if v <= MAX_SAFE {
            Ok(Self(v))
        } else {
            Err("unsafe integer")
        }
    }
}
impl From<Revision> for u64 {
    fn from(v: Revision) -> Self {
        v.0
    }
}

// deserialize_with prevents Serde's implicit missing Option field => None default.
fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}
macro_rules! dto {
    ($name:ident { $($(#[$attr:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "snake_case")]
        pub struct $name { $($(#[$attr])* pub $field: $ty),* }
    };
}
dto!(AppConfig { schema_version: u32, app_version: String, revision: Revision, last_updated: UtcTimestamp, groups: Vec<GroupItem>, materials: Vec<MaterialItem> });
dto!(GroupItem { id: Id, #[serde(deserialize_with = "required_nullable")] parent_id: Option<Id>, name: String, order: u32 });
dto!(MaterialItem { id: Id, group_id: Id, name: String, role: MaterialRole, target_type: TargetType, path: String,
    #[serde(deserialize_with = "required_nullable")] window_match_pattern: Option<String>, order: u32 });
dto!(SettingsCandidate { candidate_id: Id, kind: CandidateKind,
    #[serde(deserialize_with = "required_nullable")] revision: Option<Revision>,
    #[serde(deserialize_with = "required_nullable")] last_updated: Option<UtcTimestamp> });
dto!(SettingsLoadResponse { mode: SettingsMode,
    #[serde(deserialize_with = "required_nullable")] config: Option<AppConfig>,
    #[serde(deserialize_with = "required_nullable")] source_schema_version: Option<u32>, candidates: Vec<SettingsCandidate>,
    #[serde(deserialize_with = "required_nullable")] notice_code: Option<String> });
dto!(LoadSettingsRequest {});
dto!(EmptyResponse {});
dto!(ResolveSettingsIssueRequest { action: ResolveAction, #[serde(deserialize_with = "required_nullable")] candidate_id: Option<Id> });
dto!(SaveSettingsRequest {
    config: AppConfig,
    expected_revision: Revision
});
dto!(SaveSettingsResponse {
    revision: Revision,
    last_updated: UtcTimestamp
});
dto!(SyncStatusesRequest { material_ids: Vec<Id>, request_id: RequestId });
dto!(SyncStatusesResponse { request_id: RequestId, results: Vec<MaterialStatusResult> });
dto!(ActivateOrLaunchRequest { material_id: Id });
dto!(OpenContainingFolderRequest { material_id: Id });
dto!(BatchLaunchRequest { group_id: Id });
dto!(BatchLaunchResponse { results: Vec<LaunchResponse> });
dto!(PrepareDroppedFilesRequest { paths: Vec<String> });
dto!(DroppedFileCandidate {
    name: String,
    path: String,
    target_type: TargetType
});
dto!(DroppedFileFailure { path: String, reason: String });
dto!(PrepareDroppedFilesResponse { candidates: Vec<DroppedFileCandidate>, failures: Vec<DroppedFileFailure> });
dto!(ListWindowsRequest {
    request_id: RequestId
});
dto!(WindowListItem {
    window_id: Id,
    app_name: String,
    title: String,
    executable_name: String
});
dto!(ListWindowsResponse {
    request_id: RequestId,
    windows: Vec<WindowListItem>,
    exclusions: Vec<String>
});
dto!(WindowActionRequest { window_id: Id });
dto!(WindowActionResponse { window_id: Id });
dto!(SaveWindowExclusionsRequest { patterns: Vec<String> });
dto!(SaveWindowExclusionsResponse { patterns: Vec<String> });
dto!(MaterialStatusResult { material_id: Id, open_state: OpenState, confidence: Confidence, path_state: PathState,
    #[serde(deserialize_with = "required_nullable")] detail: Option<String> });
dto!(LaunchResponse { material_id: Id, outcome: LaunchOutcome, #[serde(deserialize_with = "required_nullable")] error: Option<AppError> });
dto!(AppError { code: ErrorCode, message: String, #[serde(deserialize_with = "required_nullable")] material_id: Option<Id>, retryable: bool });
impl AppError {
    // No caller-provided OS details, paths, queries or document contents.
    pub fn new(code: ErrorCode, material_id: Option<Id>) -> Self {
        Self {
            code,
            message: "操作を完了できませんでした。".into(),
            material_id,
            retryable: code.retryable(),
        }
    }
}
pub trait Validate {
    fn validate(&mut self) -> Result<(), AppError>;
}
fn ensure(ok: bool) -> Result<(), AppError> {
    if ok {
        Ok(())
    } else {
        Err(AppError::new(ErrorCode::ValidationError, None))
    }
}
macro_rules! structural {
    ($($t:ty),+) => { $(impl Validate for $t { fn validate(&mut self) -> Result<(), AppError> { Ok(()) } })+ };
}
structural!(
    SettingsCandidate,
    LoadSettingsRequest,
    EmptyResponse,
    SaveSettingsResponse,
    SyncStatusesRequest,
    SyncStatusesResponse,
    ActivateOrLaunchRequest,
    OpenContainingFolderRequest,
    BatchLaunchRequest,
    MaterialStatusResult,
    ListWindowsRequest,
    WindowActionRequest,
    WindowActionResponse
);
fn valid_window_text(value: &str, maximum: usize, require_nonblank: bool) -> bool {
    value.chars().count() <= maximum
        && !value.chars().any(|c| c == '\0' || c == '\u{7f}')
        && (!require_nonblank || nonblank(value))
}
pub fn validate_window_exclusions(patterns: &mut Vec<String>) -> Result<(), AppError> {
    ensure(patterns.len() <= 64)?;
    let mut seen = HashSet::new();
    for pattern in patterns.iter_mut() {
        *pattern = pattern.trim().to_owned();
        ensure(valid_window_text(pattern, 128, true) && pattern != "*")?;
        ensure(seen.insert(pattern.to_lowercase()))?;
    }
    Ok(())
}
impl Validate for WindowListItem {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(valid_window_text(&self.app_name, 256, true))?;
        ensure(valid_window_text(&self.title, 4096, true))?;
        ensure(valid_window_text(&self.executable_name, 260, true))
    }
}
impl Validate for ListWindowsResponse {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(self.windows.len() <= 512)?;
        let mut ids = HashSet::new();
        for item in &mut self.windows {
            item.validate()?;
            ensure(ids.insert(item.window_id.as_str().to_owned()))?;
        }
        validate_window_exclusions(&mut self.exclusions)
    }
}
impl Validate for SaveWindowExclusionsRequest {
    fn validate(&mut self) -> Result<(), AppError> {
        validate_window_exclusions(&mut self.patterns)
    }
}
impl Validate for SaveWindowExclusionsResponse {
    fn validate(&mut self) -> Result<(), AppError> {
        validate_window_exclusions(&mut self.patterns)
    }
}
impl Validate for PrepareDroppedFilesRequest {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(!self.paths.is_empty() && self.paths.len() <= 100)?;
        ensure(
            self.paths
                .iter()
                .all(|path| !path.is_empty() && path.len() <= 32_767),
        )
    }
}
impl Validate for DroppedFileCandidate {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(nonblank(&self.name))?;
        ensure(matches!(
            self.target_type,
            TargetType::File | TargetType::Folder
        ))?;
        ensure(windows_absolute_path(&self.path))
    }
}
impl Validate for DroppedFileFailure {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(!self.path.is_empty() && self.path.len() <= 32_767)?;
        ensure(matches!(self.reason.as_str(), "not_found" | "inaccessible" | "unsupported" | "duplicate" | "invalid_path"))
    }
}
impl Validate for PrepareDroppedFilesResponse {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(!self.candidates.is_empty() && self.candidates.len() + self.failures.len() <= 100)?;
        for candidate in &mut self.candidates {
            candidate.validate()?;
        }
        for failure in &mut self.failures { failure.validate()?; }
        Ok(())
    }
}
fn nonblank(s: &str) -> bool {
    s.chars().any(|c| !c.is_whitespace() && c != '\u{feff}')
}
impl Validate for GroupItem {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(nonblank(&self.name) && self.order > 0 && self.parent_id.as_ref() != Some(&self.id))
    }
}
// Lexical only: never probes a drive or UNC share. Device namespaces/ADS and
// ambiguous Win32 components are not document paths.
pub fn windows_absolute_path(path: &str) -> bool {
    let p = path.replace('/', "\\");
    let extended = p.starts_with("\\\\?\\");
    let p = p.strip_prefix("\\\\?\\").unwrap_or(&p);
    let unc = if extended {
        p.strip_prefix("UNC\\")
    } else {
        p.strip_prefix("\\\\")
    };
    let tail = if let Some(unc) = unc {
        let parts: Vec<_> = unc.split('\\').collect();
        if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
            return false;
        }
        unc
    } else {
        let b = p.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return false;
        }
        &p[3..]
    };
    let tail = tail.strip_suffix('\\').unwrap_or(tail);
    tail.is_empty()
        || tail.split('\\').all(|c| {
            let stem = c.split('.').next().unwrap_or("").to_ascii_uppercase();
            !c.is_empty()
                && c != "."
                && c != ".."
                && !c.ends_with(['.', ' '])
                && !c
                    .chars()
                    .any(|ch| ch <= '\u{1f}' || ch == '\u{7f}' || "<>:\"|?*".contains(ch))
                && !matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                )
                && !(stem.starts_with("COM") || stem.starts_with("LPT"))
                    .then(|| {
                        matches!(
                            &stem[3..],
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    })
                    .unwrap_or(false)
        })
}

pub fn windows_shell_path(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    if normalized
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\UNC\\"))
    {
        format!("\\\\{}", &normalized[8..])
    } else if normalized
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\"))
    {
        normalized[4..].to_owned()
    } else {
        normalized
    }
}
impl Validate for MaterialItem {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(nonblank(&self.name) && self.order > 0)?;
        ensure(
            self.window_match_pattern
                .as_ref()
                .is_none_or(|s| s.chars().count() <= 128),
        )?;
        if self.window_match_pattern.as_deref() == Some("") {
            self.window_match_pattern = None;
        }
        ensure(!self.path.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))?;
        if self.target_type == TargetType::Url {
            ensure(
                self.path
                    .get(..8)
                    .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
                    && !self
                        .path
                        .chars()
                        .any(|c| c.is_whitespace() || c == '\u{feff}' || c == '\\'),
            )?;
            ensure(tauri::Url::parse(&self.path).is_ok_and(|u| {
                u.scheme() == "https" && u.host_str().is_some_and(|h| !h.is_empty())
            }))?;
        } else {
            ensure(windows_absolute_path(&self.path))?;
        }
        Ok(())
    }
}
impl Validate for AppConfig {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(self.schema_version == 3)?;
        let mut groups = HashMap::new();
        let mut orders: HashMap<(Option<String>, Option<String>), Vec<u32>> = HashMap::new();
        for g in &mut self.groups {
            g.validate()?;
            ensure(
                groups
                    .insert(
                        g.id.as_str().to_owned(),
                        g.parent_id.as_ref().map(|p| p.as_str().to_owned()),
                    )
                    .is_none(),
            )?;
            orders
                .entry((g.parent_id.as_ref().map(|p| p.as_str().to_owned()), None))
                .or_default()
                .push(g.order);
        }
        // Iterative traversal avoids stack overflow for deeply nested input.
        let mut complete = HashSet::new();
        for start in groups.keys() {
            let mut chain = HashSet::new();
            let mut current = Some(start.as_str());
            while let Some(id) = current {
                if complete.contains(id) {
                    break;
                }
                ensure(chain.insert(id.to_owned()))?;
                current = groups
                    .get(id)
                    .ok_or_else(|| AppError::new(ErrorCode::ValidationError, None))?
                    .as_deref();
            }
            complete.extend(chain);
        }
        let mut materials = HashSet::new();
        for m in &mut self.materials {
            m.validate()?;
            ensure(
                materials.insert(m.id.as_str().to_owned())
                    && groups.contains_key(m.group_id.as_str()),
            )?;
            let role = match m.role {
                MaterialRole::Main => "main",
                MaterialRole::Reference => "reference",
            };
            orders
                .entry((Some(m.group_id.as_str().to_owned()), Some(role.into())))
                .or_default()
                .push(m.order);
        }
        for values in orders.values_mut() {
            values.sort_unstable();
            ensure(values.iter().enumerate().all(|(i, v)| *v as usize == i + 1))?;
        }
        Ok(())
    }
}
impl Validate for SettingsLoadResponse {
    fn validate(&mut self) -> Result<(), AppError> {
        if let Some(c) = &mut self.config {
            c.validate()?;
        }
        if self.mode == SettingsMode::Ready {
            ensure(self.config.is_some())?;
        }
        if matches!(
            self.mode,
            SettingsMode::ReadOnlyFutureSchema | SettingsMode::ReadOnlyUnavailable
        ) {
            ensure(self.config.is_none())?;
        }
        if self.mode == SettingsMode::ReadOnlyFutureSchema {
            ensure(self.source_schema_version.is_some_and(|v| v > 3))?;
        }
        Ok(())
    }
}
impl Validate for ResolveSettingsIssueRequest {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(
            matches!(
                self.action,
                ResolveAction::RestoreCandidate | ResolveAction::ImportLegacy
            ) == self.candidate_id.is_some(),
        )
    }
}
impl Validate for SaveSettingsRequest {
    fn validate(&mut self) -> Result<(), AppError> {
        self.config.validate()?;
        ensure(
            self.config.revision == self.expected_revision
                && self.expected_revision.get() < MAX_SAFE,
        )
    }
}
impl Validate for AppError {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(self.retryable == self.code.retryable())
    }
}
impl Validate for LaunchResponse {
    fn validate(&mut self) -> Result<(), AppError> {
        ensure(
            matches!(
                self.outcome,
                LaunchOutcome::Activated | LaunchOutcome::Launched | LaunchOutcome::NotTrackable
            ) == self.error.is_none(),
        )?;
        if let Some(e) = &mut self.error {
            e.validate()?;
        }
        Ok(())
    }
}
impl Validate for BatchLaunchResponse {
    fn validate(&mut self) -> Result<(), AppError> {
        for r in &mut self.results {
            r.validate()?;
        }
        Ok(())
    }
}
pub fn decode<T: DeserializeOwned + Serialize + Validate>(
    value: Value,
    error_code: ErrorCode,
) -> Result<T, AppError> {
    let mut dto: T =
        serde_json::from_value(value.clone()).map_err(|_| AppError::new(error_code, None))?;
    // Serde's derive can accept positional arrays for structs. JSON IPC permits objects only.
    fn object_shapes(input: &Value, canonical: &Value) -> bool {
        match canonical {
            Value::Object(fields) => input.as_object().is_some_and(|obj| {
                fields
                    .iter()
                    .all(|(k, v)| obj.get(k).is_some_and(|i| object_shapes(i, v)))
            }),
            Value::Array(items) => input.as_array().is_some_and(|a| {
                a.len() == items.len() && a.iter().zip(items).all(|(i, v)| object_shapes(i, v))
            }),
            _ => true,
        }
    }
    let canonical = serde_json::to_value(&dto).map_err(|_| AppError::new(error_code, None))?;
    if !object_shapes(&value, &canonical) {
        return Err(AppError::new(error_code, None));
    }
    dto.validate()
        .map_err(|_| AppError::new(error_code, None))?;
    Ok(dto)
}
pub fn decode_config(value: Value) -> Result<SettingsLoadResponse, AppError> {
    let schema = value
        .get("schema_version")
        .and_then(Value::as_u64)
        .filter(|v| *v <= u32::MAX as u64)
        .ok_or_else(|| AppError::new(ErrorCode::ValidationError, None))? as u32;
    if schema != 3 {
        return Ok(SettingsLoadResponse {
            mode: if schema > 3 {
                SettingsMode::ReadOnlyFutureSchema
            } else {
                SettingsMode::ReadOnlyUnavailable
            },
            config: None,
            source_schema_version: Some(schema),
            candidates: vec![],
            notice_code: Some("READ_ONLY_SCHEMA".into()),
        });
    }
    Ok(SettingsLoadResponse {
        mode: SettingsMode::Ready,
        config: Some(decode(value, ErrorCode::ValidationError)?),
        source_schema_version: Some(3),
        candidates: vec![],
        notice_code: None,
    })
}
