# MeetDock 基本・詳細設計書 (v2.4)

> 本書は、実装時の判断基準となる基本設計・詳細設計と、画面挙動を確認するためのフロントエンドモックをまとめたものである。  
> 第6章のHTMLは画面プロトタイプであり、PDF.js・Windows API・Tauri IPCそのものを再現する実装ではない。製品実装では第3～5章および第7～10章の契約を満たすこと。
> 責務境界、Mediator、IPC、PDF、Windows、受入試験の詳細契約は、同階層の各実装前確認文書を本書の一部として扱う。重複記載に差がある場合は、2026-09-19更新の実装前確認文書を優先する。

## 1. システム基本構成・アーキテクチャ

### 1.1 システム概要

**MeetDock（ミートドック）**は、会議・定例会・案件対応等の業務において参照・利用するローカルファイル、フォルダ、およびWebリソース（クラウド資料）の一元管理と迅速なアクセスを提供するWindowsネイティブデスクトップアプリケーションである。
資料を「メイン資料（開く前提）」と「参考資料（必要に応じて参照）」に分類定義し、アプリ自身の多重起動防止、多層判定による文書ウィンドウの特定、可能な範囲での前面化、安全な順次一括起動、リンク状態の早期検知、およびツール内PDFプレビューを実現する。

本システムにおける「起動状態」は、対象種別に応じて次の意味を持つ。Windowsおよび外部アプリの制約上、すべての資料について完全な起動状態や強制的な前面化を保証しない。

### 1.1.1 製品名称

| 項目 | 表記 |
| --- | --- |
| 正式名称 | MeetDock |
| 読み | ミートドック |
| 説明名称 | 会議・関連資料ランチャー |
| 画面表示 | MeetDock |
| キャッチコピー | 会議に必要な資料を、まとめて開く。 |

| 対象 | 状態判定 | UI表示 |
| --- | --- | --- |
| Excel / Word | COM/ROTで絶対パスが一致する文書を検出 | 起動中／未検出／判定不能 |
| PowerPoint・PDF・一般ファイル | ウィンドウタイトル、既知PID、必要に応じたRestart Managerの補助情報を組み合わせる | 起動中（推定）／未検出／判定不能 |
| フォルダ | アプリが起動したExplorerのPID/HWNDをセッション中のみ追跡 | 開いた履歴あり／未追跡 |
| URL | アプリが起動要求を完了したことのみ記録 | 起動済み（追跡なし） |
| リンク状態 | ファイル検査結果を独立管理 | 存在／不存在／タイムアウト／アクセス拒否／未確認 |

### 1.2 技術スタック

* **ホストフレームワーク**: Tauri v2
* **バックエンド言語**: Rust 2021
* Windows APIバインディング: `windows` crate (v0.58+)
* 非同期ランタイム: `tokio` (features: `full`)
* シリアライズ / デシリアライズ: `serde`, `serde_json`
* COM/OLEインターフェース: `windows::Win32::System::Com`
* Restart Manager: `windows::Win32::System::RestartManager`


* **フロントエンド**: WebView2（HTML5 / CSS3 / ES2022 Vanilla JavaScript）
* **PDFレンダリングエンジン**: Mozilla `pdfjs-dist`（採用時に固定バージョンを記録）
* **ローカルPDF配信**: `material://`カスタムプロトコル（HTTP Range相当の応答を実装）
* **多重起動防止**: Windows Named MutexまたはTauri single-instanceプラグイン

### 1.3 アプリケーション構成

* **フロントエンド層 (WebView2 / Vanilla JS)**:
* 階層ツリーナビゲーション、インクリメンタル検索、DnDインポート
* メイン／参考資料のセパレート一覧ビュー、同期状態バッジ表示
* 可変スプリッター（280px〜800px）によるPDF.jsプレビューペイン
* クールダウンタイマー（TTL: 2秒）による過剰なフォーカス同期の抑制


* **IPC / アセットプロトコル層**:
* 型付けされたTauriコマンド（`invoke`）によるデータ通信
* 登録済み`material_id`のみを受け付ける`material://`カスタムプロトコルによるPDF Range配信
* 実ファイルパスはフロントエンドへ公開せず、Rust側でIDから解決




* **バックエンド層 (Rust Native Engine)**:
* `ConfigManager`: アトミック書き込み・3世代ローテーションバックアップによるJSON永続化
* `WindowManager`: COM/ROTモニカ走査、Restart Managerバッチ登録、タイトルのリテラル照合による多層ウィンドウ特定とRAIIスレッド同期前面化


* `FileChecker`: ローカル検査とUNC検査を分離し、UNCは専用2ワーカー・64件キューで実行。600msはUI応答待ちの上限であり、OS処理の中断保証ではない
* `Launcher`: 250msスロットリング順次プロセス起動エンジン
* `SingleInstanceGuard`: アプリ自身の多重起動防止と、二重起動時の既存ウィンドウ通知
* `MaterialProtocol`: PDF Range応答、認可、MIME判定、読み取り上限を担当



---

## 2. データモデル・永続化設計

### 2.1 JSONスキーマ定義

設定ファイルは `%APPDATA%/com.meetdock.app/settings.json` に配置する。製品識別子は`com.meetdock.app`とする。

```json
{
  "schema_version": 3,
  "app_version": "2.3.0",
  "revision": 12,
  "last_updated": "2026-09-19T08:35:00Z",
  "groups": [
    {
      "id": "grp_01",
      "parent_id": null,
      "name": "SNK-R",
      "order": 1
    },
    {
      "id": "grp_02",
      "parent_id": "grp_01",
      "name": "週次定例会議",
      "order": 1
    }
  ],
  "materials": [
    {
      "id": "mat_01",
      "group_id": "grp_02",
      "name": "最新の進捗管理",
      "role": "main",
      "target_type": "file",
      "path": "C:\\Work\\SNK-R\\Weekly\\進捗管理表.xlsx",
      "window_match_pattern": "進捗管理表",
      "order": 1
    },
    {
      "id": "mat_02",
      "group_id": "grp_02",
      "name": "システム構成資料",
      "role": "reference",
      "target_type": "file",
      "path": "C:\\Work\\SNK-R\\Weekly\\システム構成資料.pdf",
      "window_match_pattern": null,
      "order": 2
    },
    {
      "id": "mat_03",
      "group_id": "grp_02",
      "name": "プロジェクトWiki",
      "role": "reference",
      "target_type": "url",
      "path": "https://internal-wiki.example.com/snk-r",
      "window_match_pattern": null,
      "order": 3
    }
  ]
}

```

### 2.2 データ型定義 (Rust)

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub schema_version: u32,
    pub app_version: String,
    pub revision: u64,
    pub last_updated: String,
    pub groups: Vec<GroupItem>,
    pub materials: Vec<MaterialItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupItem {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialItem {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub role: MaterialRole,       // "main" | "reference"
    pub target_type: TargetType,   // "file" | "folder" | "url"
    pub path: String,
    pub window_match_pattern: Option<String>,
    pub order: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MaterialRole {
    Main,
    Reference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetType {
    File,
    Folder,
    Url,
}

```

### 2.3 アトミック書き込み・世代管理アルゴリズム

1. **プロセス内排他**: `ConfigManager`の非同期Mutexで同時保存を直列化する。Mutex取得後に現行ファイルを再読込する。
2. **楽観ロック**: `config.revision == expected_revision`かつディスク上の`revision == expected_revision`を必須とし、不一致は`CONFIG_CONFLICT`とする。
3. **revision採番**: 初期設定を0とし、Rustが保存成功時に`checked_add(1)`で増加させる。JSON/IPCではJavaScript安全整数`9,007,199,254,740,991`を上限とし、呼出側が次revisionや`last_updated`を指定することはできない。
4. **検証**: ID重複、孤立参照、グループ循環、重複順序、空名称、絶対パス、https URL、128文字以下のリテラルタイトルヒントを検証する。
5. **一時ファイル生成**: 同一ディレクトリにランダム接尾辞付き一時ファイルを排他的に作り、完全なschema 3 JSONを書き、`File::sync_all()`後に再読込検証する。
6. **バックアップ準備**: 現行が有効なら削除・移動せず`.bak.new`へコピーし、同期して再検証する。現行が破損している場合は破損内容をバックアップへ昇格しない。
7. **3世代ローテーション**: `.bak2`を`.bak3`、`.bak1`を`.bak2`、`.bak.new`を`.bak1`の順に`MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`で置換する。途中停止による世代重複は許容するが、現行を失わない。
8. **原子的置換**: 現行がある場合は`ReplaceFileW`を優先し、初回だけ`MoveFileExW(MOVEFILE_WRITE_THROUGH)`を使用する。失敗時は現行を残し`CONFIG_IO`を返す。
9. **後処理**: 成功時だけ一時ファイルを削除し、Rustが確定した`revision`と`last_updated`を返す。失敗時の一時ファイルは次回起動時の検証候補とする。
10. **起動時修復**: `settings.json`、残存一時ファイル、`.bak1`～`.bak3`を検証し、revision降順で候補表示する。自動復元せず、利用者が選んだ`candidate_id`だけを復元する。

### 2.4 データ整合性ルール

* `groups.id`と`materials.id`はそれぞれ一意であること。
* `parent_id`は自身を指さず、祖先をたどって循環しないこと。
* `group_id`は必ず存在するグループを指すこと。
* `order`は同一親・同一区分内で正規化し、1からの連番とすること。
* `target_type=url`では初期版は`https`だけを許可する。管理設定による例外は設けない。
* 実行時状態（起動中、リンク状態、最終検査時刻、PID/HWND）は設定JSONへ保存しないこと。
* `schema_version > 3`は内容をschema 3として推測せず、設定を変更しない読み取り専用画面で起動する。
* 初期版以前に製品schema 1/2は配布されていないため、自動マイグレーションは実装しない。schema 1/2は読み取り専用とし、将来必要になった時点でfixture付きmigrationを別schemaで追加する。
* 旧試作版の`%APPDATA%/com.launcher.meeting/settings.json`は、schema 3として完全検証でき、新パスに設定がない場合だけ一度だけ移行候補にする。承認時は元ファイルを残して新パスへコピーし、拒否時はそのセッション中は再表示しない。
* 現行と全バックアップが破損している場合は、初期化またはファイルを変更しない読み取り専用起動を選ばせる。

---

## 3. Tauri IPC インターフェース仕様

```rust
// 設定管理
#[tauri::command]
async fn load_settings() -> Result<SettingsLoadResponse, AppError>;

#[tauri::command]
async fn resolve_settings_issue(
    request: ResolveSettingsIssueRequest
) -> Result<SettingsLoadResponse, AppError>;

#[tauri::command]
async fn save_settings(
    request: SaveSettingsRequest
) -> Result<SaveSettingsResponse, AppError>;

// バッチ状態同期（Restart Manager補助情報＋ローカル／UNC分離検証）
#[tauri::command]
async fn sync_material_statuses(
    request: SyncStatusesRequest
) -> Result<SyncStatusesResponse, AppError>;

// 単一資料の前面化または起動
#[tauri::command]
async fn activate_or_launch(
    request: ActivateOrLaunchRequest
) -> Result<LaunchResponse, AppError>;

// メイン資料の一括起動（250msスロットリング）
#[tauri::command]
async fn batch_launch_main(
    request: BatchLaunchRequest
) -> Result<BatchLaunchResponse, AppError>;

// 親フォルダをExplorerで開く
#[tauri::command]
async fn open_containing_folder(request: OpenContainingFolderRequest) -> Result<EmptyResponse, AppError>;

```

---

## 4. ウィンドウ特定・前面化エンジン詳細設計

### 4.1 多層ウィンドウ特定シーケンス

| 判定層 | 判定方式 | 対象フォーマット | メカニズムと特定基準 |
| --- | --- | --- | --- |
| **第1層** | COM Running Object Table (ROT) 走査 | Office文書（Excel, Word） | `GetRunningObjectTable` でROTを走査。ドキュメントの絶対パス（`FullName`）と一致するCOMインスタンスの `Application.Hwnd` を取得。 |
| **第2層** | Windows Restart Manager API（補助判定）

 | 一般ファイル（PDF、テキスト等） | 関連ファイルを一括登録して利用プロセス候補を取得する。ただし一括結果からファイルとPIDの対応は確定できないため、個別資料の「起動中」確定には使用しない。

 |
| **第3層** | タイトル照合（フォールバック） | PowerPoint、PDF、メモリ展開型エディタ等 | `EnumWindows`で取得した可視ウィンドウについてPID、実行ファイル名、正規化済みタイトルを照合。ファイル名または最大128文字の明示的なタイトルヒントをリテラル部分一致させ、正規表現は実行しない。複数候補は`unknown`とする。 |

Restart Managerは「登録リソースを使用しているプロセス候補の一括取得」に限定する。同一アプリの複数タブや、読み込み後にファイルハンドルを閉じるアプリでは対象文書を特定できないため、状態結果には`confidence`（`exact`／`estimated`／`unknown`）を付与する。

### 4.2 RAIIパターンによる安全な前面化制御 (Win32 API)

```rust
use windows::Win32::Foundation::{HWND, BOOL};
use windows::Win32::UI::WindowsAndMessaging::{
    IsWindow, IsIconic, ShowWindow, SetForegroundWindow, BringWindowToTop,
    GetWindowThreadProcessId, SW_RESTORE,
};
use windows::Win32::System::Threading::{GetCurrentThreadId, AttachThreadInput};

// スレッド同期のデタッチ漏れを100%防止するRAIIガード
struct ThreadInputGuard {
    current: u32,
    target: u32,
    attached: bool,
}

impl ThreadInputGuard {
    fn new(current: u32, target: u32) -> Self {
        let attached = if current != target {
            unsafe { AttachThreadInput(current, target, BOOL(1)).as_bool() }
        } else {
            false
        };
        Self { current, target, attached }
    }
}

impl Drop for ThreadInputGuard {
    fn drop(&mut self) {
        if self.attached {
            unsafe {
                AttachThreadInput(self.current, self.target, BOOL(0));
            }
        }
    }
}

pub fn try_foreground_window(hwnd: HWND) -> Result<(), String> {
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return Err("WINDOW_NOT_FOUND".into());
        }
        if IsIconic(hwnd).as_bool() {
            ShowWindow(hwnd, SW_RESTORE);
        }

        let current_thread = GetCurrentThreadId();
        let target_thread = GetWindowThreadProcessId(hwnd, None);

        // RAIIガード生成（スコープアウト時に自動デタッチ）
        let _guard = ThreadInputGuard::new(current_thread, target_thread);

        if !BringWindowToTop(hwnd).as_bool() {
            return Err("BRING_TO_TOP_FAILED".into());
        }
        if !SetForegroundWindow(hwnd).as_bool() {
            // Windowsのフォアグラウンド制限により拒否される場合がある。
            // 呼び出し側でFlashWindowExによる通知へフォールバックする。
            return Err("FOREGROUND_DENIED".into());
        }
    }
    Ok(())
}

```

---

## 5. CPU・メモリ負荷およびI/O制御設計

### 5.1 PDF.js Range Request

従来の「Rustバイナリ全読み込み → Tauri IPC → V8ヒープ展開」は使用しない。Rust側に`material://pdf/{material_id}`カスタムプロトコルを実装し、登録済みIDから対象PDFを解決してRange要求へ応答する。

* `Accept-Ranges: bytes`、正しい`Content-Length`、`206 Partial Content`、`Content-Range`、不正Range時の`416`を実装する。
* フロントエンドから渡された実パスを使用せず、Rust側の設定から正規化済みパスを取得する。
* WebView2＋PDF.jsで初回取得量と追加ページ取得を確認する。暗号化PDF、線形化／非線形化PDFも試験対象とする。
* 単一Rangeの`start-end`、`start-`、`-suffix`を扱い、複数Rangeは`416`とする。1応答は8 MiBまでに制限する。
* 部分取得不可時の全体取得は32 MiBまでとし、超過は`PDF_FALLBACK_TOO_LARGE`として外部アプリで開く導線を出す。
* 不正・未知・非PDFのmaterial IDは一律`404`、登録PDFの権限拒否は`403`とする。
* `pdfjs-dist` 5.4.149のWorkerを同梱し、`unsafe-eval`、CDN、実行時ダウンロードを使用しない。
* メモリ削減率は試験前に固定値で表現せず、同一PDF・同一操作の実測値を性能試験記録へ残す。

PDF切替時は次の順序で破棄する。

1. 実行中の`renderTask.cancel()`を呼び出す。
2. 表示世代トークンを更新し、旧レンダリングの完了結果を無視する。
3. Canvasの幅・高さを0へ戻す。
4. `pdfDocument.cleanup()`を呼び出す。
5. `await pdfDocument.destroy()`でWorker解放完了を待つ。

### 5.2 Restart Managerバッチ集約

関連ファイルを1つのRestart Managerセッションへまとめて登録し、利用プロセス候補を一括取得する。戻り値はセッション全体の候補であり、ファイルとPIDの対応を表さないため、個別資料の起動状態確定には使用しない。

実装では以下を必須とする。

* セッションをRAII型で包み、すべての終了経路で`RmEndSession`を呼ぶ。
* `RmRegisterResources`を含む全APIの戻り値を確認する。
* `RmGetList`の`ERROR_MORE_DATA`を上限付きで再処理する。
* 返却配列は実際の取得件数までに切り詰める。
* アクセス拒否、タイムアウト、対象なしを区別してログへ残す。

### 5.3 ファイル存在確認とUNC隔離

ローカルパスは通常のメタデータ取得で確認する。UNCパスは応答不能になる可能性があるため、Tokioの共用blocking poolへ投入せず、専用の固定2ワーカー・64件キューへ投入する。タイムアウト後も代替ワーカーを増殖させない。

600msはUIが結果を待つ時間の上限であり、開始済みOSファイルI/Oを停止する保証ではない。`timeout(spawn_blocking(...))`だけで処理が中断される設計にはしない。以下を組み合わせる。

* キュー長64件と同一正規化パスの重複排除
* 成功・不存在・タイムアウト・アクセス拒否・未確認の分類
* 成功・不存在30秒、アクセス拒否・エラー・タイムアウト10秒の短期キャッシュ
* タイムアウト後10秒間の再試行禁止
* キュー満杯は`PATH_QUEUE_BUSY`とし、ローカル検査とUI操作を継続

状態モデル例：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PathState {
    Exists,
    Missing,
    Timeout,
    AccessDenied,
    Error,
    Unchecked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathCheckResult {
    pub material_id: String,
    pub state: PathState,
    pub checked_at: String,
    pub detail: Option<String>,
}
```

### 5.4 フォーカス復帰同期のデバウンス

Alt+Tabやダイアログ開閉による重複同期を抑えるため、フロントエンド側に2秒のクールダウンを設ける。手動同期は対象外とし、進行中の自動同期がある場合は要求を統合する。同期要求と応答には`request_id`を付与し、古い応答で新しい表示を上書きしない。

---

## 6. 実装用フロントエンドモック (HTML/CSS/JavaScript)

本章は画面構成、操作順序、レスポンシブ挙動を確認するための単体実行可能なプロトタイプである。ブラウザ単体ではWindows API、Tauri IPC、実ファイルパスDnD、PDF.js Range配信を模擬表示とする。製品実装時は`demoMode`を廃止し、第3章のIPCアダプターへ置き換える。

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MeetDock v2.3</title>
<style>
:root{
  color-scheme:light;
  --bg:#f4f6f9;--panel:#ffffff;--panel-sub:#f8f9fa;--text:#1f2328;--muted:#636c76;
  --line:#d0d7de;--line-light:#e1e4e8;--accent:#0969da;--accent2:#ddf4ff;--accent3:#054da7;
  --success:#1a7f37;--success-bg:#dafbe1;--danger:#cf222e;--danger-bg:#ffebe9;
  --main-badge:#8250df;--main-badge-bg:#fbefff;
  --ref-badge:#57606a;--ref-badge-bg:#eaeef2;
  --shadow:0 1px 3px rgba(31,35,40,.08),0 8px 24px rgba(31,35,40,.08);
  --r:8px;
}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI Variable","Yu Gothic UI",Meiryo,system-ui,sans-serif;font-size:13px;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit}button{cursor:pointer}svg{display:block}.ico{width:16px;height:16px}.ico-sm{width:14px;height:14px}
.app{height:100%;display:grid;grid-template-columns:var(--sidebar-w, 250px) minmax(500px,1fr) auto;overflow:hidden;transition:grid-template-columns .15s ease}
.app.sidebar-collapsed{grid-template-columns:0 minmax(500px,1fr) auto}
.sidebar{background:#f6f8fa;border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0;overflow:hidden;position:relative}
.brand{height:54px;padding:12px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line-light)}
.brand-mark{width:30px;height:30px;border-radius:6px;background:linear-gradient(135deg,#0969da,#044289);color:#fff;display:grid;place-items:center}
.brand-title{font-weight:700;font-size:13.5px;line-height:1.2}.brand-sub{font-size:10px;color:var(--muted)}
.side-search{padding:8px 12px;border-bottom:1px solid var(--line-light);position:relative}
.search-box{width:100%;height:30px;border:1px solid var(--line);border-radius:6px;padding:0 26px 0 28px;font-size:11.5px;outline:none;background:#fff}
.search-box:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(9,105,218,.15)}
.search-ico{position:absolute;left:20px;top:15px;color:var(--muted);pointer-events:none}
.search-clear{position:absolute;right:18px;top:13px;width:18px;height:18px;border:0;background:transparent;color:var(--muted);display:none;place-items:center;border-radius:50%}
.search-clear.show{display:grid}
.side-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 4px}
.side-label{font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.tree{padding:4px 8px;overflow-y:auto;flex:1}
.tree-node{position:relative}
.tree-line{width:100%;border:0;background:transparent;border-radius:6px;min-height:32px;display:grid;grid-template-columns:18px 18px minmax(0,1fr) auto;align-items:center;gap:4px;padding:3px 6px;color:#333;text-align:left}
.tree-line:hover{background:#eaedf0}
.tree-line.active{background:var(--accent2);color:var(--accent3);font-weight:700}
.tree-toggle{width:18px;height:18px;border:0;background:transparent;padding:0;display:grid;place-items:center;color:var(--muted)}
.tree-toggle.placeholder{visibility:hidden}
.tree-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.tree-count{font-size:10px;padding:0 5px;border-radius:999px;background:#e1e4e8;color:var(--muted)}
.tree-line.active .tree-count{background:#b6e3ff;color:var(--accent3)}
.tree-children{margin-left:14px;padding-left:4px;border-left:1px solid var(--line-light)}
.tree-node.collapsed>.tree-children{display:none}
.tree-node.collapsed>.tree-line .chev{transform:rotate(-90deg)}
.chev{transition:.1s ease}
.main{min-width:0;display:flex;flex-direction:column;overflow:hidden;background:#fff}
.topbar{height:52px;border-bottom:1px solid var(--line);padding:0 16px;display:flex;align-items:center;justify-content:space-between;background:#fff}
.topbar-left{display:flex;align-items:center;gap:8px;min-width:0}
.breadcrumbs{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.breadcrumbs .current{font-weight:700;color:var(--text)}
.top-actions{display:flex;align-items:center;gap:6px}
.btn{height:30px;border:1px solid var(--line);border-radius:6px;background:#fff;color:#24292f;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:5px;font-weight:600;font-size:11.5px;position:relative;overflow:hidden}
.btn:hover{background:#f3f4f6}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{background:#0854b0}
.btn.batch-main{background:#6f42c1;border-color:#6f42c1;color:#fff}
.btn.batch-main:hover{background:#5a32a3}
.btn.batch-main.processing{pointer-events:none}
.btn.icon{width:30px;padding:0}
.btn-progress{position:absolute;left:0;bottom:0;top:0;background:rgba(255,255,255,.28);width:0%;transition:width .2s ease;pointer-events:none}
.workspace{display:flex;flex:1;min-height:0;overflow:hidden;position:relative}
.content{flex:1;overflow-y:auto;padding:16px 20px;min-width:0}
.drop-zone{border:2px dashed var(--line);border-radius:var(--r);padding:10px;text-align:center;color:var(--muted);margin-bottom:14px;font-size:11.5px;background:#f8f9fa;transition:.15s}
.drop-zone.dragover{border-color:var(--accent);background:var(--accent2);color:var(--accent3)}
.page-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
h1{margin:0;font-size:18px;letter-spacing:-.01em}
.section-header{display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line-light)}
.section-title-wrap{display:flex;align-items:center;gap:8px}
.section-title{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase}
.section-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px}
.section-badge.main{background:var(--main-badge-bg);color:var(--main-badge)}
.section-badge.ref{background:var(--ref-badge-bg);color:var(--ref-badge)}
.panel{border:1px solid var(--line);border-radius:var(--r);background:#fff;overflow:hidden;margin-bottom:14px;min-height:46px;transition:background .15s}
.panel.drag-target-over{background:#f0f6ff;border-color:var(--accent)}
.list-header,.resource-row{display:grid;grid-template-columns:minmax(220px,2fr) 80px minmax(130px,1.2fr) 110px 165px;column-gap:10px;align-items:center}
.list-header{height:32px;padding:0 12px;background:#f6f8fa;border-bottom:1px solid var(--line-light);color:var(--muted);font-size:10.5px;font-weight:700}
.resource-row{padding:8px 12px;border-bottom:1px solid var(--line-light);position:relative;cursor:grab;background:#fff;transition:background .1s}
.resource-row:active{cursor:grabbing}
.resource-row:last-child{border-bottom:0}
.resource-row:hover{background:#f8f9fa}
.resource-row.opened{background:#f3faf5}
.resource-row.missing{background:#fff8f8}
.resource-row.dragging{opacity:.4;background:#eaeef2}
.resource-main{display:flex;align-items:center;gap:9px;min-width:0}
.file-icon{width:32px;height:32px;flex:0 0 auto;border-radius:6px;display:grid;place-items:center;font-size:8.5px;font-weight:800;border:1px solid var(--line-light)}
.file-icon.xlsx{background:#eaf5ea;color:#107c41}
.file-icon.pptx{background:#fdf1ec;color:#c43e1c}
.file-icon.docx{background:#edf3fc;color:#185abd}
.file-icon.pdf{background:#fdeded;color:#c42b1c}
.file-icon.url{background:#f0f3f6;color:#0969da}
.display-name{font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-name{color:var(--muted);font-size:10.5px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.role-tag{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;display:inline-block;text-align:center}
.role-tag.main{background:var(--main-badge-bg);color:var(--main-badge)}
.role-tag.ref{background:var(--ref-badge-bg);color:var(--ref-badge)}
.path{color:var(--muted);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-col{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.status{height:20px;padding:0 7px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700}
.status i{width:6px;height:6px;border-radius:50%;display:block}
.status.open{color:var(--success);background:var(--success-bg)}
.status.open i{background:var(--success)}
.status.closed{color:var(--muted);background:#eaeef2}
.status.closed i{background:#8c959f}
.status.error{color:var(--danger);background:var(--danger-bg)}
.status.error i{background:var(--danger)}
.status-desc{font-size:9.5px;color:var(--danger);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:105px}
.row-actions{justify-self:end;display:flex;align-items:center;gap:4px}
.action-btn{height:26px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:0 7px;font-size:11px;font-weight:600}
.action-btn:hover{background:#f3f4f6}
.action-btn.more{width:26px;padding:0;display:grid;place-items:center}
.empty-state{padding:24px 16px;text-align:center;color:var(--muted);font-size:11.5px}
.empty-state svg{margin:0 auto 6px;color:#abb4be}
.resizer{width:6px;cursor:col-resize;background:transparent;transition:background .15s}
.resizer:hover,.resizer.resizing{background:var(--accent)}
.sidebar-resizer{position:absolute;right:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:20;background:transparent;transition:background .15s}
.sidebar-resizer:hover,.sidebar-resizer.resizing{background:var(--accent)}
.preview-pane{width:430px;background:#3a3d40;border-left:1px solid var(--line);display:none;flex-direction:column;min-width:280px;max-width:850px}
.preview-pane.show{display:flex}
.preview-pane.maximized{position:fixed;inset:0;width:100%!important;max-width:none!important;z-index:90}
.preview-head{height:44px;padding:0 12px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
.viewer-toolbar{height:34px;background:#f8f9fa;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 10px;font-size:11px}
.toolbar-group{display:flex;align-items:center;gap:4px}
.viewer-btn{height:24px;min-width:24px;padding:0 4px;border:1px solid var(--line);border-radius:4px;background:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#333}
.viewer-btn:hover:not(:disabled){background:#eef1f4}
.viewer-btn:disabled{opacity:.4;cursor:not-allowed}
.viewer-body{flex:1;overflow:auto;padding:16px;display:flex;justify-content:center;align-items:flex-start}
#pdfCanvas{box-shadow:0 4px 14px rgba(0,0,0,.45);background:#fff;transition:transform .12s ease}
.toast{position:fixed;right:20px;bottom:20px;z-index:120;background:#24292f;color:#fff;padding:8px 12px;border-radius:6px;font-size:11.5px;opacity:0;transform:translateY(6px);transition:.15s;pointer-events:none}
.toast.show{opacity:1;transform:translateY(0)}
.context-menu{position:fixed;z-index:100;width:180px;background:#fff;border:1px solid var(--line);border-radius:6px;box-shadow:var(--shadow);padding:4px;display:none}
.context-menu.show{display:block}
.menu-item{width:100%;height:28px;border:0;background:transparent;border-radius:4px;display:flex;align-items:center;gap:7px;padding:0 8px;font-size:11.5px;color:var(--text);text-align:left}
.menu-item:hover{background:#f3f4f6}
.menu-item.danger{color:var(--danger)}
.menu-sep{height:1px;background:var(--line-light);margin:3px 0}
.modal-backdrop{position:fixed;inset:0;z-index:110;background:rgba(0,0,0,.35);display:none;place-items:center}
.modal-backdrop.show{display:grid}
.modal{width:440px;background:#fff;border-radius:8px;box-shadow:var(--shadow);overflow:hidden}
.modal-head{padding:12px 16px;border-bottom:1px solid var(--line-light);font-weight:700}
.modal-body{padding:14px 16px;display:grid;gap:10px}
.field label{display:block;font-size:11px;font-weight:700;margin-bottom:3px;color:var(--muted)}
.field input,.field select{width:100%;height:30px;border:1px solid var(--line);border-radius:5px;padding:0 8px;font-size:11.5px;outline:none}
.modal-actions{padding:10px 16px;border-top:1px solid var(--line-light);background:var(--panel-sub);display:flex;justify-content:flex-end;gap:6px}
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v7A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.5z"/><path d="M8 11h8M8 14h5"/></svg></div>
      <div><div class="brand-title">MeetDock</div><div class="brand-sub">会議・関連資料ランチャー</div></div>
    </div>
    <div class="side-search">
      <svg class="ico-sm search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="text" class="search-box" id="globalSearch" placeholder="資料を高速検索 (Ctrl+F)..." />
      <button class="search-clear" id="searchClear" title="クリア">×</button>
    </div>
    <div class="side-head">
      <span class="side-label">グループ</span>
      <button class="btn icon" style="width:22px;height:22px" id="addGroupBtn" title="新規グループを追加"><svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>
    </div>
    <nav class="tree" id="groupTree"></nav>
    <div class="sidebar-resizer" id="sidebarResizer" title="ドラッグで幅調整 / ダブルクリックで初期化"></div>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="topbar-left">
        <button class="btn icon" id="sidebarToggle" title="サイドバー表示切替"><svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v14H4z"/><path d="M9 5v14"/></svg></button>
        <div class="breadcrumbs" id="breadcrumbs"></div>
      </div>
      <div class="top-actions">
        <button class="btn batch-main" id="batchOpenMainBtn" title="メイン資料を一括起動">
          <div class="btn-progress" id="batchProgress"></div>
          <svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span id="batchBtnText">メイン資料を一括起動</span>
        </button>
        <button class="btn" id="refreshBtn"><svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>同期</button>
        <button class="btn primary" id="addMaterialBtn"><svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>資料追加</button>
      </div>
    </header>

    <div class="workspace">
      <section class="content" id="mainContent">
        <div class="drop-zone" id="dropZoneBanner">ファイルをドラッグ＆ドロップして追加</div>
        <div class="page-head">
          <div><h1 id="pageTitle">週次定例会議</h1></div>
          <div style="font-size:11px;color:var(--muted)" id="updatedAt">同期: 18:35</div>
        </div>

        <!-- メイン資料 -->
        <div class="section-header">
          <div class="section-title-wrap">
            <span class="section-title">メイン資料</span>
            <span class="section-badge main" id="mainCountBadge">0件</span>
          </div>
        </div>
        <div class="panel" id="mainMaterialPanel" data-role="main">
          <div class="list-header"><div>表示名 / ファイル名</div><div>区分</div><div>パス / URL</div><div>状態</div><div style="text-align:right">操作</div></div>
          <div id="mainMaterialList"></div>
        </div>

        <!-- 参考資料 -->
        <div class="section-header">
          <div class="section-title-wrap">
            <span class="section-title">参考資料</span>
            <span class="section-badge ref" id="refCountBadge">0件</span>
          </div>
        </div>
        <div class="panel" id="refMaterialPanel" data-role="reference">
          <div class="list-header"><div>表示名 / ファイル名</div><div>区分</div><div>パス / URL</div><div>状態</div><div style="text-align:right">操作</div></div>
          <div id="refMaterialList"></div>
        </div>
      </section>

      <!-- リサイズスプリッター -->
      <div class="resizer" id="resizer" title="ドラッグで幅調整 / ダブルクリックで初期化"></div>

      <!-- PDFプレビューペイン -->
      <aside class="preview-pane" id="previewPane">
        <div class="preview-head">
          <span id="previewName" style="font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">システム構成資料.pdf</span>
          <div style="display:flex;gap:4px">
            <button class="btn icon" id="maximizePreview" title="最大化切替"><svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg></button>
            <button class="btn icon" id="closePreview" title="プレビューを閉じる (Esc)"><svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
          </div>
        </div>
        <div class="viewer-toolbar">
          <div class="toolbar-group">
            <button class="viewer-btn" id="prevPageBtn" title="前のページ">‹</button>
            <span id="pageIndicator" style="font-size:10.5px;margin:0 4px">1 / 3</span>
            <button class="viewer-btn" id="nextPageBtn" title="次のページ">›</button>
          </div>
          <div class="toolbar-group">
            <button class="viewer-btn" id="zoomOutBtn" title="縮小">－</button>
            <span id="zoomIndicator" style="font-size:10.5px;min-width:36px;text-align:center">100%</span>
            <button class="viewer-btn" id="zoomInBtn" title="拡大">＋</button>
            <button class="viewer-btn" id="zoomFitBtn" style="font-size:10px" title="幅に合わせる">Fit</button>
          </div>
        </div>
        <div class="viewer-body">
          <canvas id="pdfCanvas"></canvas>
        </div>
      </aside>
    </div>
  </main>
</div>

<!-- 資料用コンテキストメニュー -->
<div class="context-menu" id="contextMenu">
  <button class="menu-item" data-menu="edit">編集</button>
  <button class="menu-item" data-menu="toggle-role">メイン／参考を切替</button>
  <button class="menu-item" data-menu="folder">保存場所を開く</button>
  <button class="menu-item" data-menu="copy">パスをコピー</button>
  <div class="menu-sep"></div>
  <button class="menu-item danger" data-menu="delete">削除</button>
</div>

<!-- グループ用コンテキストメニュー -->
<div class="context-menu" id="groupContextMenu">
  <button class="menu-item" data-gmenu="add-child">子グループを追加</button>
  <button class="menu-item" data-gmenu="rename">名前を変更</button>
  <div class="menu-sep"></div>
  <button class="menu-item danger" data-gmenu="delete">削除</button>
</div>

<!-- 資料登録/編集モーダル -->
<div class="modal-backdrop" id="modalBackdrop">
  <div class="modal">
    <div class="modal-head" id="modalTitle">資料を追加</div>
    <div class="modal-body">
      <div class="field"><label>表示名</label><input type="text" id="aliasInput" placeholder="例: 週次進捗管理表" /></div>
      <div class="field"><label>ファイルパス または Web URL</label><input type="text" id="pathInput" placeholder="C:\... または https://..." /></div>
      <div class="field">
        <label>対象種別</label>
        <select id="targetTypeInput">
          <option value="file">ファイル</option>
          <option value="folder">フォルダ</option>
          <option value="url">Web URL</option>
        </select>
      </div>
      <div class="field">
        <label>区分</label>
        <select id="roleInput">
          <option value="main">メイン資料</option>
          <option value="reference">参考資料</option>
        </select>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="cancelModal">キャンセル</button>
      <button class="btn primary" id="saveModal">保存</button>
    </div>
  </div>
</div>

<!-- グループ追加/編集モーダル -->
<div class="modal-backdrop" id="groupModalBackdrop">
  <div class="modal">
    <div class="modal-head" id="groupModalTitle">グループを追加</div>
    <div class="modal-body">
      <div class="field">
        <label>グループ名</label>
        <input type="text" id="groupNameInput" placeholder="例: 障害対応" />
      </div>
      <div class="field" id="parentGroupField">
        <label>階層</label>
        <select id="parentGroupSelect"></select>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="cancelGroupModal">キャンセル</button>
      <button class="btn primary" id="saveGroupModal">保存</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"><span id="toastText"></span></div>

<script>
// ==========================================
// 1. In-Memory Store
// ==========================================
const store = {
  schema_version: 3,
  app_version: "2.3.0",
  revision: 12,
  activeGroupId: "grp_02",
  searchQuery: "",
  groups: [
    { id: "grp_01", parent_id: null, name: "SNK-R", order: 1 },
    { id: "grp_02", parent_id: "grp_01", name: "週次定例会議", order: 1 },
    { id: "grp_03", parent_id: "grp_01", name: "障害対応・緊急保守関連グループ", order: 2 },
    { id: "grp_04", parent_id: null, name: "社内運営", order: 2 }
  ],
  materials: [
    { id: "mat_01", group_id: "grp_02", name: "最新の進捗管理", role: "main", target_type: "file", path: "C:\\Work\\SNK-R\\Weekly\\進捗管理表.xlsx", is_opened: true, is_missing: false, order: 1 },
    { id: "mat_02", group_id: "grp_02", name: "お客様説明用スライド", role: "main", target_type: "file", path: "C:\\Work\\SNK-R\\Weekly\\定例説明資料.pptx", is_opened: false, is_missing: false, order: 2 },
    { id: "mat_03", group_id: "grp_02", name: "仕様確認用・システム構成", role: "reference", target_type: "file", path: "C:\\Work\\SNK-R\\Weekly\\システム構成資料.pdf", is_opened: false, is_missing: false, order: 1 },
    { id: "mat_04", group_id: "grp_02", name: "プロジェクトWiki", role: "reference", target_type: "url", path: "https://wiki.example.com/snk-r", is_opened: false, is_missing: false, order: 2 },
    { id: "mat_05", group_id: "grp_02", name: "過去議事録共有NAS", role: "reference", target_type: "file", path: "\\\\nas\\shared\\2025_Minutes.docx", is_opened: false, is_missing: true, error_detail: "UNCタイムアウト", order: 3 }
  ],
  viewer: {
    activeMaterialId: null,
    currentPage: 1,
    totalPages: 3,
    zoomScale: 1.0
  }
};

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const toast = $('#toast'), toastText = $('#toastText');
let toastTimer;

// 動的値をHTML文字列へ埋め込む箇所では必ずエスケープする。
// 製品版では可能な限りtextContentとDOM APIで要素を構築する。
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(msg) {
  clearTimeout(toastTimer);
  toastText.textContent = msg;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function getFileExtension(path) {
  if (path.startsWith('http://') || path.startsWith('https://')) return 'url';
  const parts = path.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : 'folder';
}

function getFileName(path) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return path.split('\\').pop().split('/').pop();
}

// IPCアダプター。ブラウザ単体ではdemoModeとして保存・Windows操作を模擬する。
const tauriInvoke = window.__TAURI__?.core?.invoke ?? null;
const demoMode = !tauriInvoke;
let saveChain = Promise.resolve();

function configPayload() {
  return {
    schema_version: store.schema_version,
    app_version: store.app_version,
    revision: store.revision,
    last_updated: new Date().toISOString(),
    groups: store.groups.map(({ id, parent_id, name, order }) => ({ id, parent_id, name, order })),
    materials: store.materials.map(({ id, group_id, name, role, target_type, path, window_match_pattern = null, order }) =>
      ({ id, group_id, name, role, target_type, path, window_match_pattern, order }))
  };
}

function persistConfig() {
  if (demoMode) return Promise.resolve();
  saveChain = saveChain.then(async () => {
    const expectedRevision = store.revision;
    const response = await tauriInvoke('save_settings', {
      config: configPayload(),
      expectedRevision
    });
    store.revision = response.revision;
    return response;
  }).catch(error => {
    showToast(error?.code === 'CONFIG_CONFLICT'
      ? '他の更新と競合しました。再読込してください'
      : '設定の保存に失敗しました');
    return null; // 保存キューを回復させ、次回保存を受け付ける
  });
  return saveChain;
}

async function initialize() {
  if (!demoMode) {
    try {
      const config = await tauriInvoke('load_settings');
      store.schema_version = config.schema_version;
      store.app_version = config.app_version;
      store.revision = config.revision;
      store.groups = config.groups;
      store.materials = config.materials;
      store.activeGroupId = store.groups[0]?.id ?? null;
    } catch {
      showToast('設定を読み込めませんでした');
    }
  }
  render();
}

// ==========================================
// 2. UIレンダリング
// ==========================================
function render() {
  renderTree();
  renderBreadcrumbs();
  renderMaterials();
}

function renderTree() {
  const treeContainer = $('#groupTree');
  treeContainer.innerHTML = '';

  const roots = store.groups.filter(g => g.parent_id === null).sort((a,b) => a.order - b.order);
  roots.forEach(root => {
    treeContainer.appendChild(createTreeNode(root));
  });
}

function createTreeNode(group) {
  const children = store.groups.filter(g => g.parent_id === group.id).sort((a,b) => a.order - b.order);
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';

  const lineBtn = document.createElement('button');
  lineBtn.className = `tree-line ${store.activeGroupId === group.id ? 'active' : ''}`;
  lineBtn.title = group.name; // 長い名称もホバーで完全表示
  lineBtn.onclick = () => {
    store.activeGroupId = group.id;
    render();
  };

  lineBtn.oncontextmenu = e => {
    e.preventDefault();
    openGroupContextMenu(e, group);
  };

  const count = store.materials.filter(m => m.group_id === group.id).length;

  lineBtn.innerHTML = `
    <span class="tree-toggle ${children.length === 0 ? 'placeholder' : ''}">
      <svg class="ico-sm chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </span>
    <svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
      ${children.length > 0 ? '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/>' : '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 9h17"/>'}
    </svg>
    <span class="tree-name">${escapeHtml(group.name)}</span>
    <span class="tree-count">${count}</span>
  `;

  if (children.length > 0) {
    const toggle = lineBtn.querySelector('.tree-toggle');
    toggle.onclick = e => {
      e.stopPropagation();
      nodeEl.classList.toggle('collapsed');
    };
  }

  nodeEl.appendChild(lineBtn);

  if (children.length > 0) {
    const childContainer = document.createElement('div');
    childContainer.className = 'tree-children';
    children.forEach(child => childContainer.appendChild(createTreeNode(child)));
    nodeEl.appendChild(childContainer);
  }

  return nodeEl;
}

function renderBreadcrumbs() {
  const currentGroup = store.groups.find(g => g.id === store.activeGroupId);
  if (!currentGroup) return;

  const chain = [];
  let curr = currentGroup;
  while (curr) {
    chain.unshift(curr);
    curr = store.groups.find(g => g.id === curr.parent_id);
  }

  $('#pageTitle').textContent = currentGroup.name;
  $('#breadcrumbs').innerHTML = `<span>グループ</span>` + chain.map((g, i) => 
    `<span>›</span><span class="${i === chain.length - 1 ? 'current' : ''}">${escapeHtml(g.name)}</span>`
  ).join('');
}

function renderMaterials() {
  const mainList = $('#mainMaterialList');
  const refList = $('#refMaterialList');
  mainList.innerHTML = '';
  refList.innerHTML = '';

  const q = store.searchQuery.toLowerCase().trim();
  const currentMaterials = store.materials.filter(m => {
    const isGroup = store.searchQuery ? true : (m.group_id === store.activeGroupId);
    const isMatch = m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q);
    return isGroup && isMatch;
  });

  const mainItems = currentMaterials.filter(m => m.role === 'main').sort((a, b) => a.order - b.order);
  const refItems = currentMaterials.filter(m => m.role === 'reference').sort((a, b) => a.order - b.order);

  $('#mainCountBadge').textContent = `${mainItems.length}件`;
  $('#refCountBadge').textContent = `${refItems.length}件`;

  if (mainItems.length === 0) {
    mainList.innerHTML = `<div class="empty-state">メイン資料はありません</div>`;
  } else {
    mainItems.forEach(item => mainList.appendChild(createMaterialRow(item)));
  }

  if (refItems.length === 0) {
    refList.innerHTML = `<div class="empty-state">参考資料はありません</div>`;
  } else {
    refItems.forEach(item => refList.appendChild(createMaterialRow(item)));
  }
}

function createMaterialRow(item) {
  const row = document.createElement('div');
  const ext = getFileExtension(item.path);
  const fileName = getFileName(item.path);

  let statusClass = 'closed', statusText = '未起動';
  if (item.is_missing) {
    statusClass = 'error';
    statusText = 'リンク切れ';
  } else if (item.is_opened) {
    statusClass = 'open';
    statusText = '起動中';
  } else if (item.target_type === 'url') {
    statusText = 'Web';
  }

  row.className = `resource-row ${item.is_opened ? 'opened' : ''} ${item.is_missing ? 'missing' : ''}`;
  row.draggable = true;
  row.dataset.id = item.id;

  row.innerHTML = `
    <div class="resource-main">
      <div class="file-icon ${ext}">${ext.toUpperCase().slice(0, 4)}</div>
      <div class="resource-info">
        <div class="display-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="file-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
      </div>
    </div>
    <div><span class="role-tag ${item.role === 'main' ? 'main' : 'ref'}">${item.role === 'main' ? 'メイン' : '参考'}</span></div>
    <div class="path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</div>
    <div class="status-col">
      <span class="status ${statusClass}"><i></i>${statusText}</span>
      ${item.is_missing && item.error_detail ? `<span class="status-desc" title="${escapeHtml(item.error_detail)}">${escapeHtml(item.error_detail)}</span>` : ''}
    </div>
    <div class="row-actions">
      ${ext === 'pdf' && !item.is_missing ? `<button class="action-btn preview-btn">確認</button>` : ''}
      ${item.is_missing ? `<button class="action-btn rebind-btn">再設定</button>` : `<button class="action-btn primary-btn">${item.is_opened ? '前面化' : '開く'}</button>`}
      <button class="action-btn more">•••</button>
    </div>
  `;

  setupRowDragEvents(row, item);

  const previewBtn = row.querySelector('.preview-btn');
  if (previewBtn) {
    previewBtn.onclick = e => {
      e.stopPropagation();
      openPdfPreview(item);
    };
  }

  const primaryBtn = row.querySelector('.primary-btn');
  if (primaryBtn) {
    primaryBtn.onclick = e => {
      e.stopPropagation();
      handlePrimaryAction(item);
    };
  }

  const rebindBtn = row.querySelector('.rebind-btn');
  if (rebindBtn) {
    rebindBtn.onclick = e => {
      e.stopPropagation();
      openModal('パスの再設定', item);
    };
  }

  const moreBtn = row.querySelector('.more');
  moreBtn.onclick = e => {
    e.stopPropagation();
    openContextMenu(e, item);
  };

  return row;
}

// ==========================================
// 3. ドラッグ＆ドロップ（役割変更）
// ==========================================
let draggedItemId = null;

function setupRowDragEvents(rowEl, item) {
  rowEl.addEventListener('dragstart', e => {
    draggedItemId = item.id;
    rowEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  rowEl.addEventListener('dragend', () => {
    rowEl.classList.remove('dragging');
    $$('.panel').forEach(p => p.classList.remove('drag-target-over'));
  });
}

['mainMaterialPanel', 'refMaterialPanel'].forEach(panelId => {
  const panel = document.getElementById(panelId);
  panel.addEventListener('dragover', e => {
    e.preventDefault();
    panel.classList.add('drag-target-over');
  });

  panel.addEventListener('dragleave', () => {
    panel.classList.remove('drag-target-over');
  });

  panel.addEventListener('drop', e => {
    e.preventDefault();
    panel.classList.remove('drag-target-over');
    if (!draggedItemId) return;

    const targetRole = panel.dataset.role;
    const item = store.materials.find(m => m.id === draggedItemId);
    if (item && item.role !== targetRole) {
      item.role = targetRole;
      render();
      void persistConfig();
    }
    draggedItemId = null;
  });
});

// ==========================================
// 4. アクション制御
// ==========================================
async function handlePrimaryAction(item) {
  if (demoMode) {
    item.is_opened = true;
    renderMaterials();
    showToast(item.target_type === 'url'
      ? `ブラウザ起動を模擬しました: ${item.name}`
      : `起動／前面化を模擬しました: ${item.name}`);
    return;
  }
  try {
    const response = await tauriInvoke('activate_or_launch', { materialId: item.id });
    item.is_opened = response.state === 'launched' || response.state === 'activated';
    renderMaterials();
    showToast(response.message);
  } catch (error) {
    showToast(error?.message ?? '起動に失敗しました');
  }
}

// 一括起動
$('#batchOpenMainBtn').onclick = async () => {
  const targets = store.materials.filter(m => 
    m.group_id === store.activeGroupId && m.role === 'main' && !m.is_opened && !m.is_missing
  );

  if (targets.length === 0) {
    showToast('起動対象のメイン資料はありません');
    return;
  }

  const btn = $('#batchOpenMainBtn');
  const progress = $('#batchProgress');
  const text = $('#batchBtnText');
  btn.classList.add('processing');

  if (!demoMode) {
    try {
      const response = await tauriInvoke('batch_launch_main', { groupId: store.activeGroupId });
      response.results.forEach(result => {
        const item = store.materials.find(m => m.id === result.material_id);
        if (item) item.is_opened = result.state === 'launched' || result.state === 'activated';
      });
      renderMaterials();
      const failed = response.results.filter(r => !r.success).length;
      showToast(failed ? `${failed}件を起動できませんでした` : '一括起動が完了しました');
    } catch (error) {
      showToast(error?.message ?? '一括起動に失敗しました');
    } finally {
      progress.style.width = '0%';
      text.textContent = 'メイン資料を一括起動';
      btn.classList.remove('processing');
    }
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    const pct = Math.round(((i + 1) / targets.length) * 100);
    progress.style.width = `${pct}%`;
    text.textContent = `起動中 (${i + 1}/${targets.length})...`;

    await new Promise(r => setTimeout(r, 250));
    item.is_opened = true;
    renderMaterials();
  }

  progress.style.width = '0%';
  text.textContent = 'メイン資料を一括起動';
  btn.classList.remove('processing');
  showToast('一括起動が完了しました');
};

// 同期
let lastSyncTime = 0;
async function syncStatuses(isManual = false) {
  const now = Date.now();
  if (!isManual && now - lastSyncTime < 2000) return;
  lastSyncTime = now;

  const btn = $('#refreshBtn');
  btn.classList.add('loading');
  if (!demoMode) {
    const requestId = crypto.randomUUID();
    store.latestSyncRequestId = requestId;
    try {
      const materialIds = store.materials.map(m => m.id);
      const response = await tauriInvoke('sync_material_statuses', { materialIds, requestId });
      if (store.latestSyncRequestId !== response.request_id) return;
      response.results.forEach(result => {
        const item = store.materials.find(m => m.id === result.material_id);
        if (!item) return;
        item.is_opened = result.open_state === 'open';
        item.is_missing = result.path_state === 'missing';
        item.error_detail = ['timeout', 'access_denied', 'error'].includes(result.path_state)
          ? result.detail : null;
      });
      renderMaterials();
    } catch (error) {
      showToast(error?.message ?? '状態更新に失敗しました');
    } finally {
      btn.classList.remove('loading');
    }
    return;
  }
  setTimeout(() => {
    const d = new Date();
    const timeStr = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    $('#updatedAt').textContent = `同期: ${timeStr}`;
    btn.classList.remove('loading');
    showToast('状態を更新しました');
  }, 400);
}
$('#refreshBtn').onclick = () => syncStatuses(true);
window.addEventListener('focus', () => syncStatuses(false));

// ==========================================
// 5. PDFプレビュー操作
// ==========================================
const previewPane = $('#previewPane');
const pdfCanvas = $('#pdfCanvas');
const ctx = pdfCanvas.getContext('2d');

function cleanupPdfViewer() {
  ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
  pdfCanvas.width = 0;
  pdfCanvas.height = 0;
}

function openPdfPreview(item) {
  cleanupPdfViewer();
  store.viewer.activeMaterialId = item.id;
  store.viewer.currentPage = 1;
  store.viewer.zoomScale = 1.0;

  $('#previewName').textContent = getFileName(item.path);
  previewPane.classList.add('show');
  renderPdfPage();
}

function closePdfPreview() {
  cleanupPdfViewer();
  store.viewer.activeMaterialId = null;
  previewPane.classList.remove('show');
  previewPane.classList.remove('maximized');
}
$('#closePreview').onclick = closePdfPreview;
$('#maximizePreview').onclick = () => previewPane.classList.toggle('maximized');

function renderPdfPage() {
  const { currentPage, totalPages, zoomScale } = store.viewer;
  $('#pageIndicator').textContent = `${currentPage} / ${totalPages}`;
  $('#zoomIndicator').textContent = `${Math.round(zoomScale * 100)}%`;
  $('#prevPageBtn').disabled = currentPage <= 1;
  $('#nextPageBtn').disabled = currentPage >= totalPages;

  const baseW = 380, baseH = 530;
  pdfCanvas.width = baseW * zoomScale;
  pdfCanvas.height = baseH * zoomScale;

  ctx.save();
  ctx.scale(zoomScale, zoomScale);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, baseW, baseH);

  ctx.fillStyle = '#1f2328';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(`システム構成資料 (${currentPage}/${totalPages})`, 20, 35);
  ctx.fillStyle = '#636c76';
  ctx.font = '10.5px sans-serif';
  ctx.fillText('プレビュー表示中', 20, 52);

  ctx.strokeStyle = '#e1e4e8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(20, 64); ctx.lineTo(baseW - 20, 64); ctx.stroke();

  if (currentPage === 1) {
    ctx.fillStyle = '#0969da';
    ctx.fillRect(20, 80, 100, 60);
    ctx.fillStyle = '#1a7f37';
    ctx.fillRect(140, 80, 100, 60);
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.fillText('Web Front', 40, 114);
    ctx.fillText('App Core', 165, 114);
    ctx.fillStyle = '#333';
    ctx.fillText('1. 全体概要', 20, 170);
  } else if (currentPage === 2) {
    ctx.fillStyle = '#333';
    ctx.fillText('2. ネットワーク構成', 20, 90);
    ctx.strokeStyle = '#d0d7de';
    ctx.strokeRect(20, 110, baseW - 40, 120);
    ctx.fillStyle = '#f6f8fa';
    ctx.fillRect(21, 111, baseW - 42, 24);
  } else {
    ctx.fillStyle = '#333';
    ctx.fillText('3. セキュリティ設定', 20, 90);
  }

  ctx.fillStyle = '#eaeef2';
  for (let y = 220; y < 480; y += 16) {
    ctx.fillRect(20, y, baseW - 40 - (y % 40), 7);
  }

  ctx.restore();
}

$('#prevPageBtn').onclick = () => { if (store.viewer.currentPage > 1) { store.viewer.currentPage--; renderPdfPage(); } };
$('#nextPageBtn').onclick = () => { if (store.viewer.currentPage < store.viewer.totalPages) { store.viewer.currentPage++; renderPdfPage(); } };
$('#zoomInBtn').onclick = () => { if (store.viewer.zoomScale < 2.0) { store.viewer.zoomScale += 0.25; renderPdfPage(); } };
$('#zoomOutBtn').onclick = () => { if (store.viewer.zoomScale > 0.5) { store.viewer.zoomScale -= 0.25; renderPdfPage(); } };
$('#zoomFitBtn').onclick = () => { store.viewer.zoomScale = 1.0; renderPdfPage(); };

// ==========================================
// 6. スプリッター制御（サイドバー & プレビュー）
// ==========================================
// 右側プレビュースプリッター
const resizer = $('#resizer');
let isResizingPreview = false;

resizer.addEventListener('mousedown', () => {
  if (!previewPane.classList.contains('show')) return;
  isResizingPreview = true;
  resizer.classList.add('resizing');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

resizer.addEventListener('dblclick', () => {
  previewPane.style.width = '430px';
});

// 左側サイドバースプリッター（可変幅対応）
const sidebarResizer = $('#sidebarResizer');
const appEl = $('#app');
let isResizingSidebar = false;

sidebarResizer.addEventListener('mousedown', () => {
  if (appEl.classList.contains('sidebar-collapsed')) return;
  isResizingSidebar = true;
  sidebarResizer.classList.add('resizing');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

sidebarResizer.addEventListener('dblclick', () => {
  appEl.style.setProperty('--sidebar-w', '250px');
});

window.addEventListener('mousemove', e => {
  if (isResizingPreview) {
    const w = document.body.clientWidth - e.clientX;
    if (w < 240) {
      closePdfPreview();
      isResizingPreview = false;
    } else if (w >= 280 && w <= 850) {
      previewPane.style.width = `${w}px`;
    }
  } else if (isResizingSidebar) {
    const w = e.clientX;
    if (w >= 180 && w <= 450) {
      appEl.style.setProperty('--sidebar-w', `${w}px`);
    }
  }
});

window.addEventListener('mouseup', () => {
  if (isResizingPreview) {
    isResizingPreview = false;
    resizer.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  if (isResizingSidebar) {
    isResizingSidebar = false;
    sidebarResizer.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// ==========================================
// 7. 検索・ショートカット
// ==========================================
const searchBox = $('#globalSearch');
const searchClear = $('#searchClear');

searchBox.addEventListener('input', e => {
  store.searchQuery = e.target.value;
  searchClear.classList.toggle('show', !!store.searchQuery);
  renderMaterials();
});

searchClear.onclick = () => {
  searchBox.value = '';
  store.searchQuery = '';
  searchClear.classList.remove('show');
  renderMaterials();
  searchBox.focus();
};

window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
  } else if (e.key === 'Escape') {
    if (groupModalBackdrop.classList.contains('show')) {
      closeGroupModal();
    } else if (modalBackdrop.classList.contains('show')) {
      closeModal();
    } else if (contextMenu.classList.contains('show')) {
      closeContextMenu();
    } else if (groupContextMenu.classList.contains('show')) {
      closeGroupContextMenu();
    } else if (previewPane.classList.contains('show')) {
      closePdfPreview();
    }
  }
});

// ==========================================
// 8. 資料用コンテキストメニュー＆モーダル
// ==========================================
const contextMenu = $('#contextMenu');
let selectedItem = null;

function openContextMenu(e, item) {
  selectedItem = item;
  const r = e.target.getBoundingClientRect();
  contextMenu.style.left = `${Math.min(r.right - 180, window.innerWidth - 190)}px`;
  contextMenu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 180)}px`;
  contextMenu.classList.add('show');
}
function closeContextMenu() { contextMenu.classList.remove('show'); }

$$('.menu-item[data-menu]').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!selectedItem) return;
    const action = btn.dataset.menu;
    closeContextMenu();

    switch (action) {
      case 'edit':
        openModal('資料を編集', selectedItem);
        break;
      case 'toggle-role':
        selectedItem.role = selectedItem.role === 'main' ? 'reference' : 'main';
        renderMaterials();
        void persistConfig();
        break;
      case 'folder':
        showToast(`保存場所を開きます: ${selectedItem.path}`);
        break;
      case 'copy':
        try {
          await navigator.clipboard.writeText(selectedItem.path);
          showToast('パスをコピーしました');
        } catch {
          showToast('パスのコピーに失敗しました');
        }
        break;
      case 'delete':
        if (confirm(`「${selectedItem.name}」を削除しますか？`)) {
          store.materials = store.materials.filter(m => m.id !== selectedItem.id);
          render();
          void persistConfig();
        }
        break;
    }
  });
});

const modalBackdrop = $('#modalBackdrop');
let editingItem = null;

function openModal(title, item = null) {
  editingItem = item;
  $('#modalTitle').textContent = title;
  if (item) {
    $('#aliasInput').value = item.name;
    $('#pathInput').value = item.path;
    $('#roleInput').value = item.role;
    $('#targetTypeInput').value = item.target_type;
  } else {
    $('#aliasInput').value = '';
    $('#pathInput').value = '';
    $('#roleInput').value = 'main';
    $('#targetTypeInput').value = 'file';
  }
  modalBackdrop.classList.add('show');
  $('#aliasInput').focus();
}

function closeModal() { modalBackdrop.classList.remove('show'); }
$('#cancelModal').onclick = closeModal;
modalBackdrop.onclick = e => { if (e.target === modalBackdrop) closeModal(); };

$('#saveModal').onclick = () => {
  const name = $('#aliasInput').value.trim();
  const path = $('#pathInput').value.trim();
  const role = $('#roleInput').value;
  const targetType = $('#targetTypeInput').value;

  if (!name || !path) {
    showToast('入力してください');
    return;
  }

  if (editingItem) {
    editingItem.name = name;
    editingItem.path = path;
    editingItem.role = role;
    editingItem.target_type = targetType;
    editingItem.is_missing = false;
  } else {
    store.materials.push({
      id: `mat_${Date.now()}`,
      group_id: store.activeGroupId,
      name,
      role,
      target_type: targetType,
      path,
      is_opened: false,
      is_missing: false,
      order: store.materials.length + 1
    });
  }

  closeModal();
  render();
  void persistConfig();
};

$('#addMaterialBtn').onclick = () => openModal('資料を追加');
$('#sidebarToggle').onclick = () => $('#app').classList.toggle('sidebar-collapsed');

// ==========================================
// 9. グループ管理
// ==========================================
const groupModalBackdrop = $('#groupModalBackdrop');
const parentGroupSelect = $('#parentGroupSelect');
const groupContextMenu = $('#groupContextMenu');
let selectedGroup = null;
let editingGroup = null;

function openGroupModal(title, group = null, defaultParentId = null) {
  editingGroup = group;
  $('#groupModalTitle').textContent = title;
  $('#groupNameInput').value = group ? group.name : '';

  if (group) {
    $('#parentGroupField').style.display = 'none';
  } else {
    $('#parentGroupField').style.display = 'block';
    parentGroupSelect.innerHTML = '<option value="">最上位</option>';
    store.groups.forEach(g => {
      const isSelected = g.id === (defaultParentId || store.activeGroupId) ? 'selected' : '';
      parentGroupSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(g.id)}" ${isSelected}>${escapeHtml(g.name)}</option>`);
    });
  }

  groupModalBackdrop.classList.add('show');
  $('#groupNameInput').focus();
}

function closeGroupModal() { groupModalBackdrop.classList.remove('show'); }
$('#cancelGroupModal').onclick = closeGroupModal;
groupModalBackdrop.onclick = e => { if (e.target === groupModalBackdrop) closeGroupModal(); };

$('#saveGroupModal').onclick = () => {
  const name = $('#groupNameInput').value.trim();
  if (!name) {
    showToast('グループ名を入力してください');
    return;
  }

  if (editingGroup) {
    editingGroup.name = name;
  } else {
    const parentId = parentGroupSelect.value || null;
    const newGroupId = `grp_${Date.now()}`;
    store.groups.push({
      id: newGroupId,
      parent_id: parentId,
      name,
      order: store.groups.filter(g => g.parent_id === parentId).length + 1
    });
    store.activeGroupId = newGroupId;
  }

  closeGroupModal();
  render();
  void persistConfig();
};

$('#addGroupBtn').onclick = () => openGroupModal('グループを追加', null, store.activeGroupId);

function openGroupContextMenu(e, group) {
  selectedGroup = group;
  groupContextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 190)}px`;
  groupContextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 120)}px`;
  groupContextMenu.classList.add('show');
}
function closeGroupContextMenu() { groupContextMenu.classList.remove('show'); }

$$('.menu-item[data-gmenu]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!selectedGroup) return;
    const action = btn.dataset.gmenu;
    closeGroupContextMenu();

    switch (action) {
      case 'add-child':
        openGroupModal('子グループを追加', null, selectedGroup.id);
        break;
      case 'rename':
        openGroupModal('名前を変更', selectedGroup);
        break;
      case 'delete': {
        const hasChildren = store.groups.some(g => g.parent_id === selectedGroup.id);
        const hasMaterials = store.materials.some(m => m.group_id === selectedGroup.id);

        if (hasChildren || hasMaterials) {
          if (!confirm(`「${selectedGroup.name}」配下のグループや資料も削除されます。よろしいですか？`)) {
            return;
          }
        } else {
          if (!confirm(`「${selectedGroup.name}」を削除しますか？`)) {
            return;
          }
        }

        const deleteIds = [selectedGroup.id];
        let idx = 0;
        while (idx < deleteIds.length) {
          const pid = deleteIds[idx++];
          store.groups.filter(g => g.parent_id === pid).forEach(cg => deleteIds.push(cg.id));
        }

        store.materials = store.materials.filter(m => !deleteIds.includes(m.group_id));
        store.groups = store.groups.filter(g => !deleteIds.includes(g.id));

        store.activeGroupId = store.groups.length > 0 ? store.groups[0].id : null;
        render();
        void persistConfig();
        break;
      }
    }
  });
});

document.addEventListener('click', e => {
  if (!contextMenu.contains(e.target)) closeContextMenu();
  if (!groupContextMenu.contains(e.target)) closeGroupContextMenu();
});

// ファイルドラッグ＆ドロップ
const dropZone = $('#dropZoneBanner');
['dragenter', 'dragover'].forEach(name => dropZone.addEventListener(name, e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(name => dropZone.addEventListener(name, e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', e => {
  if (!demoMode) {
    showToast('製品版ではネイティブDnDイベントから登録します');
    return;
  }
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      store.materials.push({
        id: `mat_${Date.now()}_${i}`,
        group_id: store.activeGroupId,
        name: files[i].name.replace(/\.[^/.]+$/, ""),
        role: 'main',
        target_type: 'file',
        path: `C:\\Work\\${files[i].name}`,
        is_opened: false,
        is_missing: false,
        order: store.materials.length + 1
      });
    }
    render();
    showToast(`${files.length}件を追加しました`);
    void persistConfig();
  }
});

// 初期化
void initialize();
</script>
</body>
</html>
```

---

## 7. セキュリティ設計

### 7.1 Tauri権限境界

* Tauri capabilityはメインウィンドウに必要なコマンドだけを許可し、shellの任意コマンド実行権限は付与しない。
* 起動、保存場所表示、PDF配信の各処理は`material_id`を受け取り、Rust側で登録済み設定を再取得する。
* フロントエンドから受け取った任意の実ファイルパスを直接開かない。
* URLは既定で`https`のみ許可し、`file:`、`javascript:`、`data:`、不明な独自スキームを拒否する。
* CSPは`default-src 'self'`を基本とし、PDF Workerなど実際に必要なソースだけを追加する。`unsafe-eval`は使用しない。

### 7.2 パスとコンテンツの検証

* ファイル／フォルダパスは絶対パスへ正規化し、存在確認結果とアクセス拒否を区別する。
* `material://`はPDFとして登録されたIDだけを配信し、ディレクトリトラバーサルを拒否する。
* Range開始位置・終了位置・8 MiBの最大応答サイズを検証し、整数オーバーフローを防ぐ。
* グループ名、表示名、パス、エラー詳細は信頼済みHTMLとして扱わず、DOMの`textContent`を使用する。
* 初期版はウィンドウタイトルの正規表現を許可しない。最大128文字のタイトルヒントまたはファイル名をリテラル一致させる。

### 7.3 ログ

ログには操作時刻、コマンド名、`material_id`、結果コード、処理時間を記録する。業務URLのクエリ、ユーザー名を含む絶対パス、文書内容は既定で記録しない。ログはローテーションし、利用者が診断用に明示エクスポートできるようにする。

---

## 8. アプリケーションライフサイクル・障害時動作

### 8.1 多重起動防止

1. 起動直後、ユーザーセッション単位のNamed Mutexを取得する。
2. 取得できたプロセスをプライマリとする。
3. 二重起動側は既存プロセスへ「ウィンドウ表示」要求を送る。
4. プライマリはウィンドウ復元と前面化を試行する。拒否された場合はタスクバー通知を行う。
5. 二重起動側は設定ファイルを変更せず終了する。

### 8.2 起動時

* 設定読込中は編集・一括起動を無効化する。
* 現行設定が破損している場合、検証済みバックアップ候補を提示する。
* 復元、初期化、読み取り専用起動のいずれかを利用者が選べるようにする。
* 新しい`schema_version`は上書きせず、読み取り専用で開く。

### 8.3 一括起動

* 同一グループに対する一括起動は同時に1要求までとする。
* 資料ごとに「前面化成功」「起動成功」「対象なし」「リンク異常」「前面化拒否」「起動失敗」を返す。
* 250msは連続起動負荷を緩和する初期値であり、外部アプリの起動完了を意味しない。
* 利用者がキャンセルした場合、未着手項目だけを中止し、すでに起動した外部アプリは終了しない。
* 完了後に成功件数と失敗件数を表示し、失敗明細を確認できるようにする。

### 8.4 DnD登録

製品版ではブラウザ標準の`File`オブジェクトからパスを推測しない。Tauri/WebViewのネイティブDnDイベントからOSパスを受け取り、Rust側で正規化・検証後に登録候補を返す。複数ファイルは一括確認画面を表示し、区分と登録先グループを確定してから保存する。

---

## 9. テスト・受入基準

### 9.1 設定・データ

| ID | 試験 | 期待結果 |
| --- | --- | --- |
| CFG-01 | 通常保存中にプロセスを終了 | 現行またはいずれかの検証済みバックアップから復旧できる |
| CFG-02 | 同じrevisionを2画面から保存 | 後着側へ`CONFIG_CONFLICT`を返し、無言で上書きしない |
| CFG-03 | 循環するグループを保存 | `VALIDATION_ERROR`で拒否する |
| CFG-04 | 未知の新しいschema_versionを読込 | 上書きせず読み取り専用で開く |
| CFG-05 | 破損JSON＋正常bak1 | 復元候補を提示し、承認後に復元する |

### 9.2 起動・前面化

| ID | 試験 | 期待結果 |
| --- | --- | --- |
| WIN-01 | 起動中のExcel文書を指定 | 同じ絶対パスの文書だけを`exact`として特定し、前面化結果を成功・拒否で正しく表示する |
| WIN-02 | 同名ファイルを別フォルダから起動 | ROT対応形式では絶対パスで区別する |
| WIN-03 | Windowsが前面化を拒否 | 成功と偽装せず、タスクバー通知と理由を表示する |
| WIN-04 | タイトルに正規表現記号を含む | リテラルとして安全に照合する |
| WIN-05 | URLを起動 | 許可スキームだけを既定ブラウザへ渡し、状態は「追跡なし」とする |
| WIN-06 | 一括起動中に1件失敗 | 後続を継続し、資料別結果を表示する |

### 9.3 パス検査

| ID | 試験 | 期待結果 |
| --- | --- | --- |
| PATH-01 | 存在するローカルファイル | `Exists` |
| PATH-02 | 存在しないローカルファイル | `Missing` |
| PATH-03 | 権限のないパス | `AccessDenied` |
| PATH-04 | 応答しないUNC | UIは規定時間内に`Timeout`を表示し、共用blocking poolを枯渇させない |
| PATH-05 | 同じUNCを連続同期 | 重複要求を統合し、再試行間隔を守る |

### 9.4 PDF

| ID | 試験 | 期待結果 |
| --- | --- | --- |
| PDF-01 | 100MB以上のPDFを開く | 初回表示前に全体取得せず、Range応答を確認できる |
| PDF-02 | 高速に別PDFへ切替 | 旧レンダリングが新Canvasを上書きしない |
| PDF-03 | 不正Range | `416`を返し、アプリが停止しない |
| PDF-04 | 暗号化PDF | 都度パスワードを要求し、3回失敗または取消で終了する。非対応暗号方式は外部起動導線を表示する |
| PDF-05 | 破損PDF | 他の資料操作へ影響せずエラーを表示する |

### 9.5 セキュリティ・UI

| ID | 試験 | 期待結果 |
| --- | --- | --- |
| SEC-01 | 表示名へ`<img onerror=...>`を入力 | 文字列として表示し、スクリプトを実行しない |
| SEC-02 | `javascript:` URLを登録 | 保存時に拒否する |
| SEC-03 | 未登録IDでmaterialプロトコルへ要求 | 一律`404`を返し、存在有無と実パスを露出しない |
| UI-01 | 検索中に結果を選択 | 所属グループを表示し、選択後も文脈を確認できる |
| UI-02 | 保存失敗 | 編集内容を保持し、未保存状態と再試行手段を表示する |
| UI-03 | キーボードのみで操作 | 主要機能へ到達でき、フォーカス位置を視認できる |

---

## 10. 性能目標・計測条件

性能値は「削減率」ではなく、再現可能な条件付き目標として管理する。

| 項目 | 初期目標 | 条件 |
| --- | --- | --- |
| アプリ初期表示 | 2秒以内 | 代表PC、資料500件、グループ100件 |
| ローカル状態同期 | 1秒以内 | ローカル資料200件、キャッシュなし |
| UNC混在同期のUI応答 | 1秒以内に暫定結果 | UNCタイムアウト20件を含む。残処理はバックグラウンド継続可 |
| 検索結果更新 | 100ms以内 | 資料2,000件 |
| PDF先頭ページ表示 | 2秒以内を目標 | 代表PDF、ローカルSSD。PDF構造別に記録 |
| 待機時CPU | 平均1%未満を目標 | 自動同期停止中、代表PCで60秒計測 |

計測時はOS、CPU、メモリ、ストレージ、ネットワーク、WebView2、PDF.js、資料件数、PDF特性を記録する。目標未達時も結果を隠さず、ボトルネックと代替動作を記録する。

---

## 11. 実装着手・リリース条件

### 11.1 実装着手

2026-09-19のプロジェクトオーナー判断により、責務、Mediator、IPC、永続化、PDF、Windows、受入試験の設計承認をもって本実装へ条件付きで移行できる。実装順序と各段階の完了条件は`IMPLEMENTATION_HANDOFF.md`を正とする。

### 11.2 配布・リリース

以下をすべて満たすまで配布・リリースしない。

1. `material://`、PDF.js Worker、Range、CSPを製品相当buildのWebView2実機で検証している。
2. UNC 2ワーカー・64件キュー・600 ms UI期限を制御可能なSMB共有で検証している。
3. Windows 11 x64、Microsoft 365 Apps x64のExcel/WordでROT、タイトル照合、前面化制約を検証している。
4. `ReplaceFileW`、`MoveFileExW`、3世代バックアップを工程別障害注入で検証している。
5. CFG/WIN/PATH/PDF/SEC/UIの必須受入試験に合格し、証跡を保存している。

上記は処理方針を示す抜粋である。実装では`IsWindow`のimport、`GetWindowThreadProcessId`の失敗確認、`AttachThreadInput`のエラー記録、別デスクトップ判定、および`FlashWindowEx`フォールバックを含める。Windowsの制約上「必ず強制前面化できる」とは定義しない。

フロントエンドから任意パスを実行系IPCへ渡してはならない。Rust側は必ず`material_id`から保存済み設定を引き、対象種別と許可スキームを再検証する。

### 3.1 共通レスポンス・エラー契約

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub material_id: Option<String>,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSettingsResponse {
    pub revision: u64,
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialStatusResult {
    pub material_id: String,
    pub open_state: OpenState,
    pub confidence: Confidence,
    pub path_state: PathState,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusesResponse {
    pub request_id: String,
    pub results: Vec<MaterialStatusResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchResponse {
    pub material_id: String,
    pub outcome: LaunchOutcome,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchLaunchResponse {
    pub results: Vec<LaunchResponse>,
}
```

エラーコードと`retryable`の完全な一覧は`IPC_CONTRACT.md`を正とする。`message`はパスやOS内部詳細を含まないユーザー表示用とし、内部詳細は診断ログだけへ記録する。一括起動は全体を失敗扱いにせず、資料ごとの成功・失敗を返す。

### 3.2 同期の競合防止

* 状態同期要求にはUUID形式の`request_id`を付ける。
* フロントエンドは最後に発行した要求より古い応答を破棄する。
* 自動同期と手動同期が重なった場合は手動同期を優先する。
* 同一資料の起動処理中は二重起動を防ぎ、既存要求へ合流する。
