//! Manual CFG-01 kill/lock/ACL harness. Only generated directories under TEMP.
//! This example is not included in the app and never accepts a settings path.
use meetdock_lib::{
    contracts::*,
    settings::{ConfigManager, SettingsPaths},
    settings_io::{self, FileOps, NativeFileOps, Stage},
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

const MARKER: &str = "MeetDock CFG-01 generated fixture only v1";
const STAGES: &[Stage] = &[
    Stage::ReadCurrent,
    Stage::CreateDirectory,
    Stage::TempWrite,
    Stage::TempSync,
    Stage::TempVerify,
    Stage::BackupWrite,
    Stage::BackupSync,
    Stage::BackupVerify,
    Stage::RotateThree,
    Stage::RotateTwo,
    Stage::RotateOne,
    Stage::BeforeCommit,
    Stage::Replace,
    Stage::FirstMove,
    Stage::Committed,
    Stage::Cleanup,
];
struct PauseFiles {
    stop: Option<Stage>,
    partial: bool,
}
fn pause(label: &str) {
    println!("PAUSED {label} PID={}. Kill this process from another terminal, or press Enter to continue.",std::process::id());
    io::stdout().flush().unwrap();
    let mut line = String::new();
    io::stdin().read_line(&mut line).unwrap();
}
impl FileOps for PauseFiles {
    fn checkpoint(&self, stage: Stage) -> io::Result<()> {
        println!("STAGE {stage:?}");
        io::stdout().flush()?;
        if self.stop == Some(stage) {
            pause(&format!("{stage:?}"));
        }
        Ok(())
    }
    fn read(&self, p: &Path) -> io::Result<Option<Vec<u8>>> {
        NativeFileOps.read(p)
    }
    fn list(&self, p: &Path) -> io::Result<Vec<PathBuf>> {
        NativeFileOps.list(p)
    }
    fn create_directory(&self, p: &Path) -> io::Result<()> {
        NativeFileOps.create_directory(p)
    }
    fn write(&self, p: &Path, b: &[u8], exclusive: bool) -> io::Result<()> {
        if self.partial && exclusive {
            NativeFileOps.write(p, &b[..b.len() / 2], true)?;
            NativeFileOps.sync(p)?;
            pause("PartialTemp");
            return Err(io::ErrorKind::WriteZero.into());
        }
        NativeFileOps.write(p, b, exclusive)
    }
    fn sync(&self, p: &Path) -> io::Result<()> {
        NativeFileOps.sync(p)
    }
    fn move_file(&self, a: &Path, b: &Path, replace: bool) -> io::Result<()> {
        NativeFileOps.move_file(a, b, replace)
    }
    fn replace(&self, a: &Path, b: &Path, c: &Path) -> io::Result<()> {
        NativeFileOps.replace(a, b, c)
    }
    fn remove(&self, p: &Path) -> io::Result<()> {
        NativeFileOps.remove(p)
    }
}
fn fixture(revision: u64) -> Value {
    let groups:Vec<_>=(1..=100).map(|i|json!({"id":format!("g{i}"),"parent_id":null,"name":format!("Group {i}"),"order":i})).collect();
    let materials:Vec<_>=(0..500).map(|i|json!({"id":format!("m{i}"),"group_id":format!("g{}",i/5+1),"name":format!("Document {i}"),"role":"main","target_type":"file","path":format!("C:\\CFG01-Fixtures\\document-{i}.pdf"),"window_match_pattern":null,"order":i%5+1})).collect();
    json!({"schema_version":3,"app_version":"0.1.0","revision":revision,"last_updated":"2026-09-19T00:00:00Z","groups":groups,"materials":materials})
}
fn directory(id: &str) -> PathBuf {
    assert!(
        id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()),
        "Expected generated RUN_ID, never a path"
    );
    std::env::temp_dir().join(format!("MeetDock-CFG01-{id}"))
}
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.is_empty() {
        println!("cfg01 seed | seed-empty | inspect RUN_ID | restore RUN_ID INDEX | save RUN_ID [STAGE|PartialTemp]\nStages: {STAGES:?}");
        return;
    }
    if args[0] == "seed" || args[0] == "seed-empty" {
        let id = settings_io::token().unwrap();
        let root = directory(&id);
        fs::create_dir(&root).unwrap();
        fs::write(root.join("fixture.marker"), MARKER).unwrap();
        if args[0] == "seed" {
            for (name, rev) in [
                ("settings.json", 12),
                ("settings.json.bak1", 11),
                ("settings.json.bak2", 10),
                ("settings.json.bak3", 9),
            ] {
                let value = fixture(rev);
                decode::<AppConfig>(value.clone(), ErrorCode::ValidationError).unwrap();
                NativeFileOps
                    .write(
                        &root.join(name),
                        &serde_json::to_vec_pretty(&value).unwrap(),
                        true,
                    )
                    .unwrap();
                NativeFileOps.sync(&root.join(name)).unwrap();
            }
        }
        println!("RUN_ID={id}\nFIXTURE_DIRECTORY={}\nseed=meetdock-cfg01-v1; current=12; bak1=11; bak2=10; bak3=9 (seed-empty has no settings)",root.display());
        return;
    }
    let root = directory(args.get(1).expect("RUN_ID required"));
    assert!(!fs::symlink_metadata(&root)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        root.canonicalize().unwrap().parent(),
        Some(std::env::temp_dir().canonicalize().unwrap().as_path())
    );
    assert_eq!(
        fs::read_to_string(root.join("fixture.marker")).unwrap(),
        MARKER
    );
    let stage = args
        .get(2)
        .and_then(|name| STAGES.iter().find(|s| format!("{s:?}") == *name))
        .copied();
    if args[0] == "save" && args.len() > 2 {
        assert!(stage.is_some() || args[2] == "PartialTemp", "Unknown stage");
    }
    let manager = ConfigManager::new(
        SettingsPaths {
            directory: root,
            legacy: None,
        },
        PauseFiles {
            stop: stage,
            partial: args.get(2).is_some_and(|v| v == "PartialTemp"),
        },
    );
    match args[0].as_str() {
        "inspect" | "restore" => {
            let loaded = manager.load_settings(json!({})).await.unwrap();
            println!(
                "{}",
                json!({"mode":loaded.mode,"current_revision":loaded.config.as_ref().map(|c|c.revision.get()),"candidates":loaded.candidates})
            );
            if args[0] == "restore" {
                let index: usize = args.get(2).expect("INDEX required").parse().unwrap();
                let id = &loaded
                    .candidates
                    .get(index)
                    .expect("Invalid candidate index")
                    .candidate_id;
                let result = manager
                    .resolve_settings_issue(json!({"action":"restore_candidate","candidate_id":id}))
                    .await;
                println!(
                    "RESTORE {}",
                    match result {
                        Ok(r) => json!({"revision":r.config.unwrap().revision}),
                        Err(e) => json!(e),
                    }
                );
            }
        }
        "save" => {
            // seed-empty exercises initial MoveFileExW; seed exercises normal ReplaceFileW.
            let loaded = manager.load_settings(json!({})).await;
            match loaded {
                Ok(r) if r.mode == SettingsMode::Ready => {
                    let rev = r.config.unwrap().revision.get();
                    let mut config = fixture(rev);
                    config["groups"][0]["name"] = json!("Edited fixture");
                    let result = manager
                        .save_settings(json!({"config":config,"expected_revision":rev}))
                        .await;
                    println!(
                        "SAVE {}",
                        match result {
                            Ok(r) => json!(r),
                            Err(e) => json!(e),
                        }
                    );
                }
                Ok(r) => println!("Pending mode {:?}; explicit restore required", r.mode),
                Err(e) => println!("LOAD {}", json!(e)),
            }
        }
        _ => panic!("Unknown operation"),
    }
}
