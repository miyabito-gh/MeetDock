use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const FORMAT: &str = "meetdock-pdf-sidecar";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfSidecar {
    pub format: String,
    pub version: u32,
    pub material_id: String,
    pub pdf_identity: String,
    #[serde(default)]
    pub strokes: Vec<Value>,
    #[serde(default)]
    pub bookmarks: Vec<Value>,
}

impl PdfSidecar {
    pub fn new(
        material_id: String,
        pdf_identity: String,
        strokes: Vec<Value>,
        bookmarks: Vec<Value>,
    ) -> Result<Self, SidecarError> {
        let value = Self {
            format: FORMAT.into(),
            version: VERSION,
            material_id,
            pdf_identity,
            strokes,
            bookmarks,
        };
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<(), SidecarError> {
        if self.format != FORMAT
            || self.version != VERSION
            || self.material_id.trim().is_empty()
            || self.pdf_identity.trim().is_empty()
        {
            return Err(SidecarError::Invalid);
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum SidecarError {
    Io(io::Error),
    Json(serde_json::Error),
    Invalid,
    IdentityMismatch,
}
impl From<io::Error> for SidecarError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<serde_json::Error> for SidecarError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub struct PdfSidecarStore {
    directory: PathBuf,
}

impl PdfSidecarStore {
    pub fn new(config_directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: config_directory.into().join("pdf-sidecars"),
        }
    }

    pub fn save(&self, sidecar: &PdfSidecar) -> Result<PathBuf, SidecarError> {
        sidecar.validate()?;
        fs::create_dir_all(&self.directory)?;
        let path = self.path_for(&sidecar.material_id, &sidecar.pdf_identity);
        let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
        let displaced = path.with_extension(format!("json.{}.old", std::process::id()));
        let bytes = serde_json::to_vec_pretty(sidecar)?;
        let result = (|| {
            let mut file = File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            if path.exists() {
                fs::rename(&path, &displaced)?;
            }
            if let Err(error) = fs::rename(&temporary, &path) {
                if displaced.exists() {
                    let _ = fs::rename(&displaced, &path);
                }
                return Err(error);
            }
            if displaced.exists() {
                fs::remove_file(&displaced)?;
            }
            if let Ok(directory) = File::open(&self.directory) {
                let _ = directory.sync_all();
            }
            Ok::<(), io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(path)
    }

    pub fn load(
        &self,
        material_id: &str,
        pdf_identity: &str,
    ) -> Result<Option<PdfSidecar>, SidecarError> {
        if material_id.trim().is_empty() || pdf_identity.trim().is_empty() {
            return Err(SidecarError::Invalid);
        }
        let path = self.path_for(material_id, pdf_identity);
        let bytes = match fs::read(path) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let value: PdfSidecar = serde_json::from_slice(&bytes)?;
        value.validate()?;
        if value.material_id != material_id || value.pdf_identity != pdf_identity {
            return Err(SidecarError::IdentityMismatch);
        }
        Ok(Some(value))
    }

    pub fn remove(&self, material_id: &str, pdf_identity: &str) -> Result<bool, SidecarError> {
        match fs::remove_file(self.path_for(material_id, pdf_identity)) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    fn path_for(&self, material_id: &str, pdf_identity: &str) -> PathBuf {
        self.directory.join(format!(
            "{:016x}.json",
            stable_hash(&format!("{material_id}\0{pdf_identity}"))
        ))
    }
}

fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!(
            "meetdock-sidecar-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn sample(identity: &str) -> PdfSidecar {
        PdfSidecar::new(
            "../../material".into(),
            identity.into(),
            vec![serde_json::json!({"page": 1})],
            vec![serde_json::json!({"page": 2, "name": "p.2"})],
        )
        .unwrap()
    }

    #[test]
    fn round_trip_is_an_independent_file_and_does_not_touch_pdf() {
        let root = temp();
        fs::create_dir_all(&root).unwrap();
        let pdf = root.join("source.pdf");
        fs::write(&pdf, b"original pdf").unwrap();
        let store = PdfSidecarStore::new(&root);
        let sidecar = sample(pdf.to_str().unwrap());
        let path = store.save(&sidecar).unwrap();
        assert!(path.starts_with(root.join("pdf-sidecars")));
        assert_eq!(path.extension().and_then(|x| x.to_str()), Some("json"));
        assert_eq!(fs::read(&pdf).unwrap(), b"original pdf");
        assert_eq!(
            store
                .load(&sidecar.material_id, &sidecar.pdf_identity)
                .unwrap(),
            Some(sidecar)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn identity_isolated_and_corruption_is_rejected() {
        let root = temp();
        let store = PdfSidecarStore::new(&root);
        let sidecar = sample("C:/a.pdf");
        let path = store.save(&sidecar).unwrap();
        assert!(store
            .load(&sidecar.material_id, "C:/b.pdf")
            .unwrap()
            .is_none());
        fs::write(path, b"not json").unwrap();
        assert!(matches!(
            store.load(&sidecar.material_id, &sidecar.pdf_identity),
            Err(SidecarError::Json(_))
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn filename_never_contains_untrusted_ids() {
        let store = PdfSidecarStore::new("root");
        let path = store.path_for("../material", "C:/secret/file.pdf");
        assert_eq!(
            path.parent().unwrap(),
            Path::new("root").join("pdf-sidecars")
        );
        assert!(!path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("material"));
    }
}
