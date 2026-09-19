# Phase 0〜2 実装記録

実施日: 2026-09-19 / 一次実装・自動試験: Codex
独立合否レビュー: 未実施。実機受入試験: 未実施。配布・リリース不可。

## 作業基準・構成確認

- ローカルmaster、開始時HEAD `05fc281`、前コミット `2b7959a`。開始時の作業ツリーはclean、origin/masterより2コミット先。既存差分の破棄なし。
- 指定の10文書を順番に確認。正本は `IMPLEMENTATION_HANDOFF.md`、IPC/状態/責務の各契約。
- Vite + Vanilla JS / Tauri v2 + Rust 2021。既存Serde/serde_jsonを使用。URL解析は既存TauriのUrl型を使用し、依存追加・lockfile更新なし。
- capabilityはmainウィンドウの`core:default`のみ。shell権限なし。CSPは引継ぎ時どおりnull、Phase 6で候補適用・実機確定。
- ネイティブの登録コマンドは引き続きhealth_checkのみ。新しいDTOは実I/Oへ未接続。既存疎通画面は製品Presenterではなく雛形のまま。

## 実装範囲

変更ファイル一覧（18ファイル）:

- Rust: `src-tauri/src/contracts.rs`、`src-tauri/src/lib.rs`、`src-tauri/tests/contracts.rs`
- JavaScript: `src/contracts.js`、`src/ipc-adapter.js`、`src/model.js`、`src/event-chain.js`、`src/effect-runner.js`、`src/root.js`、`src/presenter.js`
- 試験・fixture: `tests/contracts.test.mjs`、`tests/model.test.mjs`、`tests/event-chain.test.mjs`、`tests/generate-fixtures.mjs`、`tests/fixtures/contracts.json`
- 文書: `MeetDock 基本・詳細設計書.md`、`PROJECT_HANDOVER.md`、`PHASE_0_2_IMPLEMENTATION.md`

`src-tauri/src/contracts.rs`:

- 全IPC request/response、設定DTO、enum、AppError。ErrorCodeだけは契約表どおりSCREAMING_SNAKE_CASE、その他enum/fieldはsnake_case。
- ID、UUID v4、UTC RFC3339、JavaScript安全整数を検証する型。null許可でもフィールド自体は必須。
- `decode<T>`で未知フィールド・構造・意味制約を検証。Serdeが許す構造体の位置配列も拒否。Phase 3以降のコマンド境界はこの検証を必ず通すこと。
- `decode_config`はschemaを先に判定。将来/旧schemaはconfig=nullの読み取り専用。空タイトルヒントをnullに正規化。https以外と制御文字入りpathを拒否。
- `AppError::new`は固定の日本語文言・コード別retryableを生成し、OS詳細を受け取らない。

`src/contracts.js` / `src/ipc-adapter.js`:

- 同じDTO境界を検証。invokeはload以外 `{ request }`、実行系は登録IDだけ。responseの相関ID・save revision+1も照合。
- 不正requestをinvoke前に拒否し、不正なresponse/errorをINTERNAL_ERRORへ変換。自動再試行なし。
- DTO構造検証がPhase 1の範囲。循環・孤立・重複・名称・順序・Windows絶対パスの業務整合性と保存直前再検証はPhase 3で追加する。

`src/model.js` / `src/event-chain.js` / `src/effect-runner.js` / `src/root.js` / `src/presenter.js`:

- 直交AppState、純粋transition、固定enum、ガード失敗時の状態同一性・副作用ゼロ。
- 保存前にSaving、起動前にrunning集合へ更新。保存競合/失敗でdraft保持。同期request_idとPDF generationで古い応答を破棄。
- 個別/一括起動の重複を抑止し、前面化拒否を成功表示しない。古い画面への起動完了通知は抑止してrunningを解消。
- RootLifecycleHandler → MediatorHandler → DiagnosticFallback固定CoR。描画後にEffectを列挙順に一度だけ開始し、結果を同じFIFOへ戻す。
- 再入イベントは256件まで。連続検索/リサイズは最新値へ統合。overflowは診断を残してFatalErrorへ移行し、黙って完了イベントを落としたまま操作を続けない。
- Root経由の未完了Effectも256件まで。上限時は遷移をcommitせず、処理中通知と副作用0回。タイマー/ポーリング/自動再試行なし。
- 状態とRenderModelをfreezeして、Presenter/Viewによる業務状態変更を防止。
- PDFはreplace/close portのみ。cancel→Canvas初期化→cleanup→destroy→新規読込の実装はPhase 6。

## 設計の補足・差異

承認済みIPCのwire形式は変更していない。次は設計表の未記載経路の補足である。

1. 移行承認は表どおりReadyへ遷移するが、移行Effectが未完了の間はresolutionで保存・編集・起動をガードする。失敗時はMigrationPendingへ戻し、明示再試行を可能にする。
2. 保存中のグループ/PDF切替でgenerationが変わった後に保存成功した場合、保存済みrevisionという事実は反映する。draftを新revisionへ合わせてDirtyで保持し、Savingを解除し、古い完了通知を出さない。現在generation一致時のみCleanへ遷移する。
3. generation上限はRootが全Effect完了（失効済み同期/PDFも含む）を確認してから0へ戻す。モデルの処理中領域がある場合は戻さない。上限到達中の新しい文脈変更は抑止する。
4. 一括起動は設計上の単一batch枠を使用。同一グループだけでなく、別グループの同時バッチも開始しない。個別起動との対象資料重複も防止する。
5. 追加の資源上限として未完了Effectを256件に制限。UIイベントoverflowは継続不能な内部状態として扱う。
6. 下位の基本・詳細設計書に残っていた自由文字列enum例とopen_containing_folderのunit応答を正本に合わせて修正。第6章のモックは製品実装へコピーしていない。
7. グループ選択/編集破棄でgenerationが変わる際は、開いているPDFをClosedへ戻してclose Effectを1回発行する。失効したPDFがLoadingのまま残ることを防ぐ。

## 自動試験と証跡

- `tests/fixtures/contracts.json` をRust/JSで共用。生成元 `tests/generate-fixtures.mjs`、固定seed `meetdock-contract-v1`（乱数不使用）。
- 正常/必須null/欠落/未知field/未知enum/未知schema/ID/UUID/日時/整数/URL/正規化/固定retryableを照合。
- `tests/model.test.mjs`のM01〜M32は状態遷移表の全32行に対応。ガード失敗、0/1回、保存失敗、古い応答、PDF切替、ReadOnly、世代上限を検証。
- `tests/event-chain.test.mjs`はFIFO、Handled停止、fallback、再入、キュー上限、Effect一度実行、Runner失敗写像、Root/Service統合をDOM/Windows API/I/Oなしで検証。
- CFG-04、WIN-05/SEC-02、UI-02、PDF-02の契約/純粋状態部分を先行検証。これら受入ID全体を合格扱いにはしない。

最終実行結果:

| コマンド | 結果 |
| --- | --- |
| `npm test` | 436件成功、失敗/skip 0 |
| `npm run build` | 成功（既存疎通画面のVite build。新コアはNode試験で実行） |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust 2試験成功。うち1試験で共有344 fixtureを全件照合 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 成功 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 成功 |
| `git diff --check` | 成功 |

fixture SHA-256: `26252FED9DA7973E75E956FC8BA8CF9282A936EB3F9303AF7D79B08A748DDE79`

JS試験のローカルログ: `artifacts/phase-0-2/npm-test.log`（gitignore対象）。buildの初回はesbuildによる親ディレクトリ参照がサンドボックスで拒否された。同じコマンドを承認された権限で再実行して成功。Rust testはMSVCリンカーのライブラリ作成メッセージがwarningとして出るが、試験失敗なし。実機受入試験・release bundle作成は実施していない。

## Phase 3に進む前の未解決事項

- 本実装の独立レビューと上記補足経路の確認。製品UI、Windows API、PDF protocol、UNC実I/O、設定永続化I/Oは未実装。
- Phase 3では完全な設定業務整合性、Mutex内revision再読込、候補ID登録と検証、工程別障害を注入可能なファイルportを実装する。commandを追加する際はDTO検証とmain限定capabilityを再確認する。
- 保存/移行/復元/読取専用の実コマンドを追加してから新Rootを製品のComposition Rootへ接続する。既存health_check画面への業務ロジック追加はしない。
- PDF/WebView2、Windows API、UNC、NTFS原子的置換の実環境検証は全て未実施。M365 x64と制御可能なSMB試験環境も未確保。
- `ACCEPTANCE_TEST_ASSIGNMENT.md`の必須実機試験、独立レビュー、プロジェクトオーナーの最終承認まで配布・リリースしない。
