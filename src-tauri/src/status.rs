//! Bounded path-status service. UNC filesystem calls only run on two dedicated threads.
use crate::contracts::{
    Confidence, MaterialItem, MaterialStatusResult, OpenState, PathState, TargetType,
};
use std::{
    collections::{HashMap, VecDeque},
    fs, io,
    path::Path,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

const WORKERS: usize = 2;
const QUEUE_CAPACITY: usize = 64;
const UI_DEADLINE: Duration = Duration::from_millis(600);
const LONG_TTL: Duration = Duration::from_secs(30);
const SHORT_TTL: Duration = Duration::from_secs(10);

pub trait PathProbe: Send + Sync + 'static {
    fn probe(&self, path: &str) -> PathState;
}

#[derive(Clone, Copy)]
pub struct NativePathProbe;
impl PathProbe for NativePathProbe {
    fn probe(&self, path: &str) -> PathState {
        match fs::metadata(Path::new(path)) {
            Ok(_) => PathState::Exists,
            Err(e) if e.kind() == io::ErrorKind::NotFound => PathState::Missing,
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => PathState::AccessDenied,
            Err(_) => PathState::Error,
        }
    }
}

struct Job {
    key: String,
    path: String,
}
struct Cached {
    state: PathState,
    expires: Instant,
}
struct QueueState {
    jobs: VecDeque<Job>,
    waiters: HashMap<String, Vec<oneshot::Sender<PathState>>>,
    cache: HashMap<String, Cached>,
}
struct Shared<P> {
    state: Mutex<QueueState>,
    ready: Condvar,
    probe: Arc<P>,
}

#[derive(Clone)]
pub struct PathStatusService<P: PathProbe = NativePathProbe> {
    shared: Arc<Shared<P>>,
}

fn key(path: &str) -> String {
    path.replace('/', "\\").to_uppercase()
}
fn is_unc(path: &str) -> bool {
    let p = path.replace('/', "\\");
    p.get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("\\\\?\\UNC\\"))
        || (p.starts_with("\\\\") && !p.starts_with("\\\\?\\") && !p.starts_with("\\\\.\\"))
}
fn ttl(state: PathState) -> Duration {
    if matches!(state, PathState::Exists | PathState::Missing) {
        LONG_TTL
    } else {
        SHORT_TTL
    }
}

impl<P: PathProbe> PathStatusService<P> {
    pub fn new(probe: P) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(QueueState {
                jobs: VecDeque::new(),
                waiters: HashMap::new(),
                cache: HashMap::new(),
            }),
            ready: Condvar::new(),
            probe: Arc::new(probe),
        });
        for index in 0..WORKERS {
            let worker = shared.clone();
            std::thread::Builder::new()
                .name(format!("meetdock-unc-{index}"))
                .spawn(move || loop {
                    let job = {
                        let mut state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
                        while state.jobs.is_empty() {
                            state = worker.ready.wait(state).unwrap_or_else(|e| e.into_inner());
                        }
                        state.jobs.pop_front().expect("queue was checked")
                    };
                    let result = worker.probe.probe(&job.path);
                    let waiters = {
                        let mut state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
                        state.cache.insert(
                            job.key.clone(),
                            Cached {
                                state: result,
                                expires: Instant::now() + ttl(result),
                            },
                        );
                        state.waiters.remove(&job.key).unwrap_or_default()
                    };
                    for waiter in waiters {
                        let _ = waiter.send(result);
                    }
                })
                .expect("failed to create fixed UNC worker");
        }
        Self { shared }
    }

    async fn unc(&self, path: String) -> Result<PathState, &'static str> {
        let normalized = key(&path);
        let receiver = {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            state.cache.retain(|_, value| value.expires > now);
            if let Some(hit) = state.cache.get(&normalized) {
                return Ok(hit.state);
            }
            let (tx, rx) = oneshot::channel();
            if let Some(waiters) = state.waiters.get_mut(&normalized) {
                waiters.push(tx);
                rx
            } else {
                if state.jobs.len() >= QUEUE_CAPACITY {
                    return Err("PATH_QUEUE_BUSY");
                }
                state.waiters.insert(normalized.clone(), vec![tx]);
                state.jobs.push_back(Job {
                    key: normalized.clone(),
                    path,
                });
                self.shared.ready.notify_one();
                rx
            }
        };
        match tokio::time::timeout(UI_DEADLINE, receiver).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Ok(PathState::Error),
            Err(_) => {
                let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
                state.cache.insert(
                    normalized,
                    Cached {
                        state: PathState::Timeout,
                        expires: Instant::now() + SHORT_TTL,
                    },
                );
                Err("PATH_TIMEOUT")
            }
        }
    }

    pub async fn check(&self, material: MaterialItem) -> MaterialStatusResult {
        let (path_state, detail) = if material.target_type == TargetType::Url {
            (PathState::Unchecked, None)
        } else if is_unc(&material.path) {
            match self.unc(material.path).await {
                Ok(state) => (state, None),
                Err("PATH_TIMEOUT") => (PathState::Timeout, Some("PATH_TIMEOUT".into())),
                Err(code) => (PathState::Unchecked, Some(code.into())),
            }
        } else {
            (self.shared.probe.probe(&material.path), None)
        };
        MaterialStatusResult {
            material_id: material.id,
            open_state: OpenState::Unknown,
            confidence: Confidence::Unknown,
            path_state,
            detail,
        }
    }
}

impl Default for PathStatusService<NativePathProbe> {
    fn default() -> Self {
        Self::new(NativePathProbe)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{Id, MaterialRole};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Probe {
        calls: AtomicUsize,
        delay: Duration,
        result: PathState,
    }
    impl PathProbe for Probe {
        fn probe(&self, _: &str) -> PathState {
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            self.result
        }
    }
    fn material(id: &str, path: &str) -> MaterialItem {
        MaterialItem {
            id: Id::try_from(id.to_owned()).unwrap(),
            group_id: Id::try_from("g1".to_owned()).unwrap(),
            name: id.into(),
            role: MaterialRole::Main,
            target_type: TargetType::File,
            path: path.into(),
            window_match_pattern: None,
            order: 1,
        }
    }

    #[tokio::test]
    async fn duplicate_unc_requests_share_one_probe_and_cache_result() {
        let service = Arc::new(PathStatusService::new(Probe {
            calls: AtomicUsize::new(0),
            delay: Duration::from_millis(30),
            result: PathState::Exists,
        }));
        let (a, b) = tokio::join!(
            service.check(material("m1", "\\\\host\\share\\a")),
            service.check(material("m2", "\\\\HOST\\share\\a"))
        );
        assert_eq!(a.path_state, PathState::Exists);
        assert_eq!(b.path_state, PathState::Exists);
        assert_eq!(service.shared.probe.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            service
                .check(material("m3", "\\\\host\\share\\a"))
                .await
                .path_state,
            PathState::Exists
        );
        assert_eq!(service.shared.probe.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stalled_unc_returns_timeout_without_growing_workers() {
        let service = PathStatusService::new(Probe {
            calls: AtomicUsize::new(0),
            delay: Duration::from_millis(750),
            result: PathState::Exists,
        });
        let start = Instant::now();
        let result = service.check(material("m1", "\\\\host\\share\\slow")).await;
        assert_eq!(result.path_state, PathState::Timeout);
        assert_eq!(result.detail.as_deref(), Some("PATH_TIMEOUT"));
        assert!(start.elapsed() < Duration::from_millis(700));
        let cached = service.check(material("m2", "\\\\host\\share\\slow")).await;
        assert_eq!(cached.path_state, PathState::Timeout);
    }

    #[test]
    fn local_probe_classifies_exists_and_missing() {
        let probe = NativePathProbe;
        assert_eq!(probe.probe(env!("CARGO_MANIFEST_DIR")), PathState::Exists);
        assert_eq!(
            probe.probe(&format!(
                "{}\\definitely-absent",
                env!("CARGO_MANIFEST_DIR")
            )),
            PathState::Missing
        );
    }

    #[test]
    fn only_network_names_are_routed_to_unc_workers() {
        assert_eq!(WORKERS, 2);
        assert_eq!(QUEUE_CAPACITY, 64);
        assert_eq!(UI_DEADLINE, Duration::from_millis(600));
        assert_eq!(ttl(PathState::Exists), Duration::from_secs(30));
        assert_eq!(ttl(PathState::Missing), Duration::from_secs(30));
        assert_eq!(ttl(PathState::AccessDenied), Duration::from_secs(10));
        assert_eq!(ttl(PathState::Error), Duration::from_secs(10));
        assert_eq!(ttl(PathState::Timeout), Duration::from_secs(10));
        assert!(is_unc("\\\\server\\share\\a.pdf"));
        assert!(is_unc("\\\\?\\UNC\\server\\share\\a.pdf"));
        assert!(!is_unc("C:\\a.pdf"));
        assert!(!is_unc("\\\\?\\C:\\a.pdf"));
        assert!(!is_unc("\\\\.\\pipe\\a"));
    }

    #[tokio::test]
    async fn full_queue_reports_busy_without_calling_probe() {
        let service = PathStatusService::new(Probe {
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            result: PathState::Exists,
        });
        {
            let mut state = service.shared.state.lock().unwrap();
            for index in 0..QUEUE_CAPACITY {
                state.jobs.push_back(Job {
                    key: format!("K{index}"),
                    path: format!("P{index}"),
                });
            }
        }
        let result = service.check(material("m1", "\\\\host\\share\\full")).await;
        assert_eq!(result.path_state, PathState::Unchecked);
        assert_eq!(result.detail.as_deref(), Some("PATH_QUEUE_BUSY"));
        assert_eq!(service.shared.probe.calls.load(Ordering::SeqCst), 0);
    }
}
