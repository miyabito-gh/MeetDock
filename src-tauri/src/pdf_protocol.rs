//! Bounded PDF custom-protocol implementation. Paths stay behind this boundary.
use crate::contracts::{MaterialItem, TargetType};
use percent_encoding::percent_decode_str;
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};
use tauri::http::{
    header::{ACCEPT_RANGES, ALLOW, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE},
    HeaderMap, Method, Response, StatusCode, Uri,
};

pub const MAX_PDF_FALLBACK_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_RANGE_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfAccessError {
    NotFound,
    Forbidden,
    Internal,
}

pub trait PdfFileOps: Send + Sync + 'static {
    fn inspect(&self, path: &Path) -> io::Result<u64>;
    fn read(&self, path: &Path, start: u64, length: usize) -> io::Result<Vec<u8>>;
}

#[derive(Default)]
pub struct NativePdfFileOps;
impl PdfFileOps for NativePdfFileOps {
    fn inspect(&self, path: &Path) -> io::Result<u64> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(io::ErrorKind::NotFound.into());
        }
        let mut file = File::open(path)?;
        let mut header = [0; 1024];
        let count = file.read(&mut header)?;
        if count == 0 || !header[..count].windows(5).any(|v| v == b"%PDF-") {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(metadata.len())
    }

    fn read(&self, path: &Path, start: u64, length: usize) -> io::Result<Vec<u8>> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

fn io_error(error: io::Error) -> PdfAccessError {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::InvalidData => PdfAccessError::NotFound,
        io::ErrorKind::PermissionDenied => PdfAccessError::Forbidden,
        _ => PdfAccessError::Internal,
    }
}

pub fn material_id(uri: &Uri) -> Option<String> {
    if uri.query().is_some() || uri.to_string().contains('#') {
        return None;
    }
    let host = uri.host()?;
    if host != "pdf" && host != "material.localhost" && host != "localhost" {
        return None;
    }
    let path = uri.path();
    let encoded = if host == "pdf" {
        path.strip_prefix('/')?
    } else {
        path.strip_prefix("/pdf/")?
    };
    if encoded.is_empty() || encoded.contains('/') || encoded.contains('\\') {
        return None;
    }
    let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
    if decoded.contains('%')
        || !(1..=64).contains(&decoded.len())
        || !decoded
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return None;
    }
    Some(decoded.into_owned())
}

pub fn authorize(
    material: &MaterialItem,
    files: &impl PdfFileOps,
) -> Result<(String, u64), PdfAccessError> {
    if material.target_type != TargetType::File
        || !Path::new(&material.path)
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("pdf"))
    {
        return Err(PdfAccessError::NotFound);
    }
    let total = files.inspect(Path::new(&material.path)).map_err(io_error)?;
    if total == 0 {
        return Err(PdfAccessError::NotFound);
    }
    Ok((material.path.clone(), total))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

fn parse_range(value: &str, total: u64) -> Option<ByteRange> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') || total == 0 {
        return None;
    }
    let (left, right) = value.split_once('-')?;
    let (start, requested_end) = if left.is_empty() {
        let suffix: u64 = right.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start: u64 = left.parse().ok()?;
        if start >= total {
            return None;
        }
        let end = if right.is_empty() {
            total - 1
        } else {
            right.parse::<u64>().ok()?.min(total - 1)
        };
        if start > end {
            return None;
        }
        (start, end)
    };
    let max_end = start
        .checked_add(MAX_RANGE_RESPONSE_BYTES - 1)
        .unwrap_or(u64::MAX);
    Some(ByteRange {
        start,
        end: requested_end.min(max_end),
    })
}

fn response(
    status: StatusCode,
    total: u64,
    range: Option<ByteRange>,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(CONTENT_LENGTH, body.len().to_string())
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range",
        );
    if matches!(
        status,
        StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE
    ) {
        builder = builder.header(ACCEPT_RANGES, "bytes");
    }
    if matches!(status, StatusCode::OK | StatusCode::PARTIAL_CONTENT) {
        builder = builder.header(CONTENT_TYPE, "application/pdf");
    }
    if let Some(r) = range {
        builder = builder.header(
            CONTENT_RANGE,
            format!("bytes {}-{}/{}", r.start, r.end, total),
        );
    } else if status == StatusCode::RANGE_NOT_SATISFIABLE {
        builder = builder.header(CONTENT_RANGE, format!("bytes */{total}"));
    }
    builder.body(body).expect("fixed response headers")
}

pub fn serve(
    method: &Method,
    headers: &HeaderMap,
    material: Result<&MaterialItem, PdfAccessError>,
    files: &impl PdfFileOps,
) -> Response<Vec<u8>> {
    if method == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(ALLOW, "GET, HEAD, OPTIONS")
            .header(CONTENT_LENGTH, "0")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Access-Control-Allow-Headers", "Range")
            .header("Access-Control-Max-Age", "86400")
            .body(vec![])
            .unwrap();
    }
    if method != Method::GET && method != Method::HEAD {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(ALLOW, "GET, HEAD, OPTIONS")
            .header(CONTENT_LENGTH, "0")
            .header("Access-Control-Allow-Origin", "*")
            .body(vec![])
            .unwrap();
    }
    let (path, total) = match material.and_then(|m| authorize(m, files)) {
        Ok(value) => value,
        Err(error) => {
            let status = match error {
                PdfAccessError::NotFound => StatusCode::NOT_FOUND,
                PdfAccessError::Forbidden => StatusCode::FORBIDDEN,
                PdfAccessError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            };
            return response(status, 0, None, vec![]);
        }
    };
    let requested = match headers.get(RANGE) {
        Some(value) => match value.to_str() {
            Ok(value) => Some(value),
            Err(_) => return response(StatusCode::RANGE_NOT_SATISFIABLE, total, None, vec![]),
        },
        None => None,
    };
    let (status, selected) = if let Some(value) = requested {
        match parse_range(value, total) {
            Some(range) => (StatusCode::PARTIAL_CONTENT, Some(range)),
            None => return response(StatusCode::RANGE_NOT_SATISFIABLE, total, None, vec![]),
        }
    } else if total > MAX_PDF_FALLBACK_BYTES {
        return response(StatusCode::PAYLOAD_TOO_LARGE, total, None, vec![]);
    } else {
        (
            StatusCode::OK,
            Some(ByteRange {
                start: 0,
                end: total - 1,
            }),
        )
    };
    let range = selected.unwrap();
    let length = (range.end - range.start + 1) as usize;
    let body = if method == Method::HEAD {
        vec![]
    } else {
        match files.read(Path::new(&path), range.start, length) {
            Ok(bytes) => bytes,
            Err(error) => {
                return response(
                    match io_error(error) {
                        PdfAccessError::NotFound => StatusCode::NOT_FOUND,
                        PdfAccessError::Forbidden => StatusCode::FORBIDDEN,
                        PdfAccessError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
                    },
                    total,
                    None,
                    vec![],
                )
            }
        }
    };
    let mut result = response(
        status,
        total,
        if status == StatusCode::PARTIAL_CONTENT {
            Some(range)
        } else {
            None
        },
        body,
    );
    if method == Method::HEAD {
        result.headers_mut().insert(CONTENT_LENGTH, length.into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{Id, MaterialRole};
    use std::{collections::HashMap, sync::Mutex};
    use tauri::http::{HeaderValue, Request};

    struct MemoryFiles {
        bytes: Vec<u8>,
        total: Option<u64>,
        reads: Mutex<Vec<(u64, usize)>>,
        inspect_error: Option<io::ErrorKind>,
    }
    impl MemoryFiles {
        fn pdf(size: usize) -> Self {
            let mut bytes = vec![b'x'; size];
            bytes[..5].copy_from_slice(b"%PDF-");
            Self {
                bytes,
                total: None,
                reads: Mutex::new(vec![]),
                inspect_error: None,
            }
        }
    }
    impl PdfFileOps for MemoryFiles {
        fn inspect(&self, _: &Path) -> io::Result<u64> {
            if let Some(kind) = self.inspect_error {
                Err(kind.into())
            } else {
                Ok(self.total.unwrap_or(self.bytes.len() as u64))
            }
        }
        fn read(&self, _: &Path, start: u64, length: usize) -> io::Result<Vec<u8>> {
            self.reads.lock().unwrap().push((start, length));
            Ok(self.bytes[start as usize..start as usize + length].to_vec())
        }
    }
    fn material() -> MaterialItem {
        MaterialItem {
            id: Id::try_from("pdf_1".to_owned()).unwrap(),
            group_id: Id::try_from("group".to_owned()).unwrap(),
            name: "PDF".into(),
            role: MaterialRole::Reference,
            target_type: TargetType::File,
            path: "C:\\private\\document.PDF".into(),
            window_match_pattern: None,
            order: 1,
        }
    }
    fn request(method: Method, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder()
            .method(method)
            .uri("material://pdf/pdf_1");
        if let Some(value) = range {
            builder = builder.header(RANGE, value);
        }
        builder.body(vec![]).unwrap()
    }
    fn call(files: &MemoryFiles, method: Method, range: Option<&str>) -> Response<Vec<u8>> {
        let req = request(method, range);
        serve(req.method(), req.headers(), Ok(&material()), files)
    }
    fn headers(response: &Response<Vec<u8>>) -> HashMap<&str, &str> {
        response
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str(), v.to_str().unwrap()))
            .collect()
    }

    #[test]
    fn url_is_exact_and_decoded_once() {
        for (uri, expected) in [
            ("material://pdf/pdf_1", Some("pdf_1")),
            ("http://material.localhost/pdf/pdf-2", Some("pdf-2")),
            ("material://localhost/pdf/pdf-2", Some("pdf-2")),
            ("material://pdf/%70df", Some("pdf")),
            ("material://pdf/a/b", None),
            ("material://pdf/%252e%252e", None),
            ("material://pdf/%2e%2e", None),
            ("material://pdf/pdf?q=1", None),
            ("material://other/pdf", None),
        ] {
            let uri: Uri = uri.parse().unwrap();
            assert_eq!(material_id(&uri).as_deref(), expected, "{uri}");
        }
    }

    #[test]
    fn get_head_and_all_range_forms_have_exact_headers() {
        let files = MemoryFiles::pdf(100);
        let full = call(&files, Method::GET, None);
        assert_eq!(full.status(), 200);
        assert_eq!(full.body().len(), 100);
        assert_eq!(headers(&full)["content-length"], "100");
        assert_eq!(headers(&full)["accept-ranges"], "bytes");
        assert_eq!(headers(&full)["access-control-allow-origin"], "*");
        assert_eq!(
            headers(&full)["access-control-expose-headers"],
            "Accept-Ranges, Content-Length, Content-Range"
        );
        let ranged = call(&files, Method::GET, Some("bytes=10-19"));
        assert_eq!(ranged.status(), 206);
        assert_eq!(ranged.body().len(), 10);
        assert_eq!(headers(&ranged)["content-range"], "bytes 10-19/100");
        let open = call(&files, Method::GET, Some("bytes=90-"));
        assert_eq!(headers(&open)["content-range"], "bytes 90-99/100");
        let suffix = call(&files, Method::GET, Some("bytes=-20"));
        assert_eq!(headers(&suffix)["content-range"], "bytes 80-99/100");
        let head = call(&files, Method::HEAD, Some("bytes=10-19"));
        assert_eq!(head.status(), 206);
        assert!(head.body().is_empty());
        assert_eq!(headers(&head)["content-length"], "10");
        assert_eq!(files.reads.lock().unwrap().len(), 4);
    }

    #[test]
    fn invalid_ranges_method_and_caps_are_bounded() {
        let files = MemoryFiles::pdf((MAX_RANGE_RESPONSE_BYTES + 20) as usize);
        let capped = call(&files, Method::GET, Some("bytes=0-999999999999"));
        assert_eq!(capped.body().len() as u64, MAX_RANGE_RESPONSE_BYTES);
        assert_eq!(
            headers(&capped)["content-range"],
            format!(
                "bytes 0-{}/{}",
                MAX_RANGE_RESPONSE_BYTES - 1,
                files.bytes.len()
            )
        );
        for value in [
            "bytes=10-9",
            "bytes=99999999-",
            "bytes=-0",
            "bytes=1-2,4-5",
            "items=0-1",
            "bytes=x-y",
            "bytes=1-2-3",
        ] {
            let invalid = call(&files, Method::GET, Some(value));
            assert_eq!(invalid.status(), 416, "{value}");
            assert_eq!(headers(&invalid)["content-length"], "0");
            assert_eq!(
                headers(&invalid)["content-range"],
                format!("bytes */{}", files.bytes.len())
            );
        }
        let post = call(&files, Method::POST, None);
        assert_eq!(post.status(), 405);
        assert_eq!(headers(&post)["allow"], "GET, HEAD, OPTIONS");
        let options = call(&files, Method::OPTIONS, None);
        assert_eq!(options.status(), 204);
        assert_eq!(headers(&options)["access-control-allow-headers"], "Range");
        assert_eq!(headers(&options)["access-control-allow-origin"], "*");
        let huge = MemoryFiles {
            bytes: b"%PDF-".to_vec(),
            total: Some(MAX_PDF_FALLBACK_BYTES + 1),
            reads: Mutex::new(vec![]),
            inspect_error: None,
        };
        let large = call(&huge, Method::GET, None);
        assert_eq!(large.status(), 413);
        assert_eq!(headers(&large)["content-length"], "0");
        assert!(huge.reads.lock().unwrap().is_empty());
    }

    #[test]
    fn authorization_and_error_statuses_do_not_expose_paths() {
        let mut non_file = material();
        non_file.target_type = TargetType::Url;
        let files = MemoryFiles::pdf(10);
        let req = request(Method::GET, None);
        assert_eq!(
            serve(req.method(), req.headers(), Ok(&non_file), &files).status(),
            404
        );
        let forbidden = MemoryFiles {
            bytes: vec![],
            total: None,
            reads: Mutex::new(vec![]),
            inspect_error: Some(io::ErrorKind::PermissionDenied),
        };
        let response = serve(req.method(), req.headers(), Ok(&material()), &forbidden);
        assert_eq!(response.status(), 403);
        assert!(response.body().is_empty());
        assert!(!format!("{:?}", response).contains("private"));
        let missing = serve(
            req.method(),
            req.headers(),
            Err(PdfAccessError::NotFound),
            &files,
        );
        assert_eq!(missing.status(), 404);
        let empty = MemoryFiles::pdf(5);
        let empty = MemoryFiles {
            bytes: empty.bytes,
            total: Some(0),
            reads: Mutex::new(vec![]),
            inspect_error: None,
        };
        assert_eq!(
            serve(req.method(), req.headers(), Ok(&material()), &empty).status(),
            404
        );
        let _ = HeaderValue::from_static("keeps import checking strict");
    }
}
