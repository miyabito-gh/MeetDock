# MeetDock 引継ぎドキュメント

更新日: 2026-09-19

## 1. プロジェクト概要

MeetDockは、会議・定例会・案件対応で使用するローカルファイル、フォルダ、Web資料をグループ単位で管理し、まとめて起動・状態確認するWindowsデスクトップアプリです。

詳細な仕様は、リポジトリ直下の `MeetDock 基本・詳細設計書.md` を正とします。第6章のHTMLは画面プロトタイプであり、製品実装では第3～5章および第7～10章の契約を満たしてください。

## 2. 現在の実装状態

### 完了

- Gitリポジトリ初期化済み
- GitHubリモート設定済み
- 初回コミット・プッシュ済み
- Tauri v2 + Rust 2021の雛形作成済み
- Vite + Vanilla JavaScriptのフロントエンド雛形作成済み
- `pdfjs-dist` 5.4.149導入済み
- `windows` crate導入済み
- Tokio、Serde、Serde JSON導入済み
- `tauri-plugin-single-instance`導入済み
- Tauri capabilityの最小構成作成済み
- CSPの初期設定作成済み
- `src-tauri/icons/icon.ico`登録済み
- Windows向けTauriバンドル設定を有効化済み
- `health_check` IPCコマンド実装済み
- Phase 0〜2: Rust DTO/enum/AppError、JS IPC adapter/validator、共通fixture契約試験
- Phase 2: 純粋Mediator、固定Event Chain、Effect Runner、Root/Presenter境界と自動試験
- 実装結果・残課題は `PHASE_0_2_IMPLEMENTATION.md` を参照。本番UIへの接続は未実施

### 未実装

- 設定JSONの保存・読込・バックアップ・マイグレーション
- `load_settings` / `save_settings`
- `sync_material_statuses`
- `activate_or_launch`
- `batch_launch_main`
- `open_containing_folder`
- Windows Named Mutex相当の二重起動側通知
- Office COM/ROT走査
- Restart Manager連携
- ウィンドウタイトル照合と前面化
- ローカル／UNCパス検査ワーカー
- `material://` PDF Rangeプロトコル
- PDF.jsプレビュー画面
- ネイティブDnD登録
- 本番UI
- Windows/PDF/UNC/原子的置換の実機試験と製品受入試験

## 3. 開発環境

確認済みの主な環境:

- Windows
- Rust stable / MSVC toolchain
- Node.js 24系
- npm 11系
- Tauri 2系
- Vite 7系

依存関係は以下で固定・管理しています。

- `package-lock.json`
- `src-tauri/Cargo.lock`

## 4. 開発コマンド

プロジェクトルートで実行します。

```powershell
npm install
npm run dev
npm run build
npm run tauri dev
npm run tauri build -- --no-sign
cargo check --manifest-path src-tauri/Cargo.toml
```

`npm run tauri build -- --no-sign` は署名なしのローカル検証用です。正式配布時はコード署名設定が必要です。

## 5. 主要ファイル

| ファイル | 役割 |
| --- | --- |
| `MeetDock 基本・詳細設計書.md` | 基本・詳細仕様の正本 |
| `IMPLEMENTATION_HANDOFF.md` | 条件付き実装移行後の着手順・完了条件の正本 |
| `IPC_CONTRACT.md` | Rust/JavaScript DTO・AppError契約 |
| `MEDIATOR_STATE_TRANSITIONS.md` | 状態・イベント・ガード・副作用契約 |
| `ACCEPTANCE_TEST_ASSIGNMENT.md` | 実装後・リリース前の受入試験割当 |
| `package.json` | Node依存関係と開発コマンド |
| `vite.config.js` | Vite設定 |
| `src/main.js` | フロントエンド起点。現在は疎通確認UI |
| `src-tauri/Cargo.toml` | Rust依存関係 |
| `src-tauri/src/lib.rs` | Tauriアプリ本体・IPC登録 |
| `src-tauri/src/main.rs` | Rustエントリポイント |
| `src-tauri/tauri.conf.json` | アプリ識別子、画面、ビルド設定 |
| `src-tauri/capabilities/default.json` | WebView権限境界 |
| `src-tauri/icons/icon.ico` | Windowsアプリアイコン |

## 6. 実装時の重要な契約

### セキュリティ

- フロントエンドから任意の実ファイルパスを実行系IPCへ渡さない。
- 起動・前面化・PDF配信は `material_id` を受け取り、Rust側で保存済み設定から対象を解決する。
- URLは既定で `https` のみ許可する。
- `file:`、`javascript:`、`data:`、不明な独自スキームは拒否する。
- `material://` は登録済みPDFのIDだけを配信する。
- 表示文字列はHTMLとして扱わず、DOMの `textContent` を使用する。
- shellの任意コマンド実行権限を付与しない。

### 永続化

- 設定ファイルの配置先は `%APPDATA%/com.meetdock.app/settings.json`。
- `schema_version` は3を初期値とする。
- revisionによる楽観ロックを使用する。
- 保存は一時ファイル、`sync_all`、バックアップローテーション、原子的置換の順で行う。
- `.bak1`～`.bak3` の3世代バックアップを想定する。
- 実行時状態は設定JSONへ保存しない。

### Windows連携

- Excel／WordはCOM ROTで絶対パス一致を優先する。
- 一般ファイルはRestart Managerを補助情報として利用するが、個別文書の確定判定には使わない。
- 初期版の実機基準はWindows 11 x64、Microsoft 365 Apps x64のExcel/Wordとする。
- 最終フォールバックは可視ウィンドウのPID、実行ファイル名、正規化タイトルのリテラル照合とし、正規表現は使わない。
- 前面化拒否を成功扱いにしない。
- `AttachThreadInput` はRAIIでデタッチ漏れを防止する。
- UNC検査は共用blocking poolへ投入せず、専用2ワーカー・64件キューを使う。

### PDF

- PDF.jsへ渡すURLは `material://pdf/{material_id}` とする。
- Range応答、`206`、`416`、`Content-Range`、`Accept-Ranges` を実装する。
- 全体取得は32 MiB、1回のRange応答は8 MiBを上限とする。
- PDF切替時は `renderTask.cancel()`、世代トークン更新、Canvas初期化、`cleanup()`、`destroy()` の順で破棄する。
- 実パスをフロントエンドへ公開しない。

## 7. 推奨実装順

1. RustのDTO・列挙型・`AppError`を`IPC_CONTRACT.md`どおりに定義し、fixture契約試験を追加する。
2. JavaScriptのMediator、Event Dispatcher、Effect Runnerを純粋関数中心で実装し、状態遷移試験を追加する。
3. `ConfigManager`、設定検証、`load_settings` / `resolve_settings_issue` / `save_settings`を実装し、障害注入可能な境界を作る。
4. ローカル／UNCパス検査と同期レスポンスを実装する。
5. URL・ファイル・フォルダの起動処理を実装する。
6. WindowsのROT、タイトル照合、前面化、Restart Managerを段階的に追加する。
7. `material://` Range、検証候補CSP、PDF.jsプレビューを実装する。
8. 資料一覧、DnD、グループ編集、一括起動、エラー表示をPassive Viewとして実装する。
9. Windows 11/WebView2/M365/SMB実機とNTFS障害注入で技術検証・受入試験を実施する。
10. 全必須試験合格後にのみ配布・リリースする。

## 8. 実装アーキテクチャ方針

実装するすべてのコンポーネントは、`Root` を起点とする階層構造の下に配置します。画面、パネル、一覧、行、ダイアログなどのUIコンポーネントは、MVPパターンにおけるPassive Viewとして扱います。

### コンポーネントの責務

- Viewは描画とユーザー入力の通知だけを担当する。
- Viewは業務ルール、永続化、Windows API呼出し、状態遷移を直接実行しない。
- Viewが操作できるのは、表示・入力・選択・活性状態など描画に関わるパラメータだけとする。
- PresenterはViewへ描画パラメータを設定し、Viewからの入力をイベントへ変換する。
- Presenter同士で直接イベントを送り合わず、Root配下のイベント経路へ戻す。

### イベントと状態遷移

- ユーザー操作や非同期処理の結果は型付けされたイベントとする。
- イベントはView → Presenter → Event Dispatcherの固定CoR（Root lifecycle → Mediator → diagnostic fallback）で1回だけ配送する。
- 動的なChain登録、親Presenter探索、Presenter間転送は行わない。
- Mediatorはアプリケーションのステートマシンとして、現在状態・イベント・ガード条件から次状態と副作用を決定する。
- 副作用はRoot配下のEffect RunnerがApplication Serviceへ1回だけ委譲する。
- 状態変更後は新しい描画モデルを生成し、Presenter経由でPassive Viewへ反映する。
- 古い非同期応答で新しい表示を上書きしないよう、状態世代またはrequest_idを必ず確認する。

### 依存方向

依存方向は、下位Viewから上位の業務ロジックへ直接向けず、次の流れを基本とします。

```text
Root
├─ Event Dispatcher → Mediator / State Machine
├─ Effect Runner → Application services / Tauri IPC adapter
└─ Presenter → Passive View components
```

Rust側のConfigManager、Launcher、FileChecker、WindowManager、MaterialProtocolは、UIコンポーネントやMediatorから直接呼び出さず、Effect RunnerとApplication Service経由で利用します。MediatorへOS依存処理を埋め込まず、サービスの結果をイベントとして受け取って状態遷移を裁定させます。

この方針により、View単体テスト、イベントチェーンのテスト、状態遷移テスト、Windows依存サービスの統合テストを分離できる構造にします。

## 9. 最初に追加すべきテスト

- 設定JSONの正常読込・保存
- revision競合時の `CONFIG_CONFLICT`
- ID重複・孤立参照・循環グループの拒否
- 新しいschema_versionの読み取り専用起動
- `https`以外のURL拒否
- 未登録 `material_id` のPDF配信拒否
- Range境界値と不正Rangeの `416`
- 表示名にHTMLを入力した場合のエスケープ
- `health_check` IPCの疎通

## 10. Git情報

- リモート: `https://github.com/miyabito-gh/MeetDock.git`
- 初期ブランチ: `master`
- 初回コミット: `95c1948`

実装単位ごとに小さくコミットし、設計書の受入ID（例: `CFG-01`、`PDF-03`）をコミットメッセージまたはPR説明に記載してください。

## 11. 注意事項

- 現在の `src/main.js` は最小の疎通確認画面であり、設計書第6章のモックはまだ製品UIへ移植していません。
- `src-tauri/gen/schemas` はTauriが生成した権限スキーマです。capability変更時はTauriコマンドで再生成される内容を確認してください。
- 現在の`src-tauri/tauri.conf.json`はCSPが`null`です。Phase 6のPDF本実装時に承認済み候補を反映し、WebView2実機検証で確定してください。
- `icon.ico` は登録済みですが、正式なブランドアイコンの更新時はTauri用の各サイズ素材も再生成してください。
- Windows API実装はWindows上でのみ実行・検証してください。

## 12. 実装移行判定

2026-09-19のプロジェクトオーナー判断により、実装移行は**条件付き可（CONDITIONAL PASS）**です。実環境検証は本実装後へ移しますが、未検証の機能を検証済みと表示したり、必須試験前に配布したりしてはいけません。

### 12.1 2026-09-19設計レビュー結果

以下はプロジェクトオーナー指示に基づき承認済みです。

- Root、Passive View、Presenter、Mediator、Effect Runner、Application Serviceの責務境界
- 固定5段のイベント経路と、Unhandled時に副作用を発行しない規則
- Mediatorの直交状態、イベント、ガード、失敗遷移、副作用規則
- Rust/JavaScript IPC DTO、AppError、ID、null、未知schema、パス境界
- schema 3、revision、3世代バックアップ、破損/将来schema/旧試作設定の扱い
- PDFの認可、Range、32 MiB fallback、8 MiB response、Worker/CSP方針
- Windows 11/M365 x64対象、ROT、Restart Manager、リテラル照合、前面化制約
- UNC 2ワーカー、64件キュー、600 ms待機、30秒/10秒キャッシュ
- CFG/WIN/PATH/PDF/SEC/UI、Mediator、Event Chainの担当ロールと試験方法

### 12.2 実装後・リリース前の必須項目

設計値は決定しましたが、以下は未検証です。記載だけで合格扱いにしません。

1. PDF.js 5.4.149、`material://` Range、Worker、CSPのWebView2実機検証
2. M365 x64 Excel/WordのROT、Restart Manager、タイトル照合、前面化拒否の実機検証
3. SMB共有でのUNC timeout、キュー、重複排除、スレッド上限の検証
4. Windows/NTFSでの`ReplaceFileW`、`MoveFileExW`、3世代バックアップの障害注入検証
5. 検証端末、SMB共有、実施者、日時、証跡保存先の登録

### 12.3 リリース条件

上記5項目を製品相当buildとテストハーネスで検証し、証跡を保存し、`ACCEPTANCE_TEST_ASSIGNMENT.md`の必須ケースへ合格した場合だけ配布・リリースできます。実装手順は`IMPLEMENTATION_HANDOFF.md`を正とします。
