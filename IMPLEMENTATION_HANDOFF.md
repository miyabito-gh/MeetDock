# MeetDock 本実装 引継ぎドキュメント

更新日: 2026-09-19
移行判定: **条件付き可（CONDITIONAL PASS）**

## 1. 目的

MeetDockの本実装を、承認済み設計に沿って小さな段階に分けて進める。操作性を損なう抽象化やバックグラウンド処理を増やさず、Windows/PDF/UNC障害時にもUIと資源使用量を有界に保つ。

実環境検証は本実装後に行う。ただし、検証可能な境界、自動試験、失敗結果を実装と同時に作り、未検証を成功扱いしない。必須実機試験の完了前に配布・リリースしてはならない。

## 2. 現在のリポジトリ

- Tauri v2 + Rust 2021 + Vite + Vanilla JavaScriptの雛形あり
- `pdfjs-dist` 5.4.149、`windows` crate、Tokio、Serde、single-instance plugin導入済み
- `health_check` IPCだけ実装済み
- 本番UI、設定、Windows連携、PDF protocol、UNC検査は未実装
- 上記は設計引継ぎ時点の記録。Phase 0〜2は`PHASE_0_2_IMPLEMENTATION.md`、Phase 3設定永続化・設定IPCは`PHASE_3_IMPLEMENTATION.md`に実装結果を記録済み。本番UIへの接続と各実機受入は未実施。
- `src-tauri/tauri.conf.json`のCSPは現在`null`
- 設計レビュー・実装引継ぎ文書はコミット`2b7959a`（`docs: finalize implementation handoff`）で保存済み。作業開始時に`git status`を確認し、この基準差分を破棄・巻き戻ししないこと

現在の作業端末ではx64、DisplayVersion 25H2、build 26200.9457、WebView2 153.0.4234.46を確認済み。Microsoft 365/Excel/Wordと制御可能なSMB試験先は未検出。

## 3. 正本と優先順位

実装判断は次の順に参照する。

1. `IMPLEMENTATION_HANDOFF.md`
2. `IPC_CONTRACT.md`
3. `MEDIATOR_STATE_TRANSITIONS.md`
4. `ARCHITECTURE_RESPONSIBILITY.md`
5. `PDF_RANGE_VERIFICATION.md`
6. `WINDOWS_API_VERIFICATION_PLAN.md`
7. `ACCEPTANCE_TEST_ASSIGNMENT.md`
8. `MeetDock 基本・詳細設計書.md` v2.4
9. `PROJECT_HANDOVER.md`

矛盾を見つけた場合は推測で実装せず、上位文書へ合わせて下位文書を同じ変更単位で修正する。

## 4. 初期版で実装しないもの

- Office 32-bit、永続ライセンス版Office、PowerPointのROT保証
- ウィンドウタイトル正規表現
- http URLや管理者による独自スキーム許可
- キー入力偽装、連続前面化、強制デスクトップ切替
- UNCヘルパープロセス、動的ワーカー増殖
- 汎用イベントバス、動的DIコンテナ、追加の状態管理ライブラリ
- PDF CDN、実行時Worker取得、`unsafe-eval`
- 将来schemaの推測読込、未配布schema 1/2の自動migration
- 自動クラウド同期、常駐監視、定期ポーリング

## 5. 実装原則

- Rootは依存を組み立てるだけとし、Mediatorを純粋な状態遷移に保つ。
- View → Presenter →固定Event Chain → Mediator → Effect Runnerの経路を崩さない。
- View、PresenterからTauri IPC、Windows API、永続化を直接呼ばない。
- Effect発行前に状態を`Saving`/`Running`へ変更し、二重実行を防ぐ。
- Windows/PDF/UNCをtraitまたは薄いportの内側へ閉じ込め、モック可能にする。
- 自動再試行を増やさない。利用者操作または明示された同期だけで再試行する。
- キュー、キャッシュ、DOM、ログ、メモリ使用量へ上限を設ける。
- UIは操作結果、未保存、処理中、timeout、前面化拒否を隠さない。

## 6. 実装順序

### Phase 0: 作業基準の固定

1. `git status`と既存差分を確認し、設計文書を保護する。
2. 現在の`package.json`、`Cargo.toml`、Tauri capability、CSPを読み取る。
3. 不要な依存を追加せず、既存依存で実装可能か確認する。
4. 各Phaseを小さなコミット単位に分ける。コミットまたはPR説明へ受入IDを記載する。

完了条件: 既存変更を失わず、実装対象とテストコマンドが明確になっている。

### Phase 1: 契約と純粋モデル

1. `IPC_CONTRACT.md`どおりにRust DTO、enum、request/response、`AppError`を定義する。
2. enumを自由文字列で保持しない。Serdeの`snake_case`を明示する。
3. ID、UUID、日時、JavaScript安全整数、null、未知フィールドの検証を実装する。
4. JavaScript側に薄いIPC adapterと同じ契約のvalidatorを作る。
5. Rust/JSが共有するfixture JSONを作り、正常・null・未知値・未知schemaを双方で試験する。

完了条件: IPC fixture試験がRust/JS双方で合格し、任意パスを受ける実行系requestが存在しない。

### Phase 2: Mediatorとイベント経路

1. `MEDIATOR_STATE_TRANSITIONS.md`の直交`AppState`を実装する。
2. 固定CoRを`RootLifecycleHandler → MediatorHandler → DiagnosticFallback`として実装する。
3. Effect RunnerはEffectを1回だけ実行し、Service結果をイベントへ戻す。
4. `revision`、`request_id`、`state_generation`を別用途として実装する。
5. 状態遷移表の全行、ガード失敗、副作用0/1回、古い応答を表駆動試験する。

完了条件: Windows API、I/O、DOMなしでMediator/Event Chain試験が合格する。

### Phase 3: 設定永続化

1. schema 3の検証、循環・孤立・重複・URL・パス検証を実装する。
2. `ConfigManager`のMutex内で現行revisionを再読込する。
3. temp書込、`sync_all`、再読込検証、bak1～3、`ReplaceFileW`/`MoveFileExW`をInfrastructureへ実装する。
4. `load_settings`、`resolve_settings_issue`、`save_settings`を実装する。
5. 破損、将来schema、旧試作パス、競合を自動試験する。
6. ファイル操作を注入可能にし、実装後の工程別障害試験を可能にする。

完了条件: CFG-02～05と通常保存の自動試験が合格し、CFG-01の実機障害注入手順が実行可能。

### Phase 4: 状態同期とパス検査

1. ローカル検査とUNC検査を分離する。
2. UNCは専用2ワーカー、64件キュー、同一パス統合、600 ms UI期限を固定する。
3. キャッシュは成功/不存在30秒、拒否/エラー/timeout 10秒とする。
4. キュー満杯を`PATH_QUEUE_BUSY`、UI期限超過を`PATH_TIMEOUT`として返す。
5. `sync_material_statuses`と古い`request_id`破棄を実装する。

完了条件: PATH-01～03とキュー/TTL/重複排除のモック試験が合格し、スレッド数が2を超えない。

### Phase 5: 起動・Windows連携

1. https URL、ファイル、フォルダの起動をID解決後に実行する。
2. 同一資料と同一グループの二重起動をMediatorで抑止する。
3. Excel/Word ROT、Restart Manager補助情報、リテラルタイトル照合を別Serviceとして実装する。
4. 前面化は有効HWND確認、最小化復元、RAII attach/detach、1回の前面化試行、必要なら1回の点滅に限定する。
5. 候補複数、権限差、別デスクトップ、HWND消失を成功扱いしない。

完了条件: WIN-04～06とWindows API分岐のモック試験が合格し、実機がなくても失敗結果を再現できる。

#### Phase 5追加差分：PID/HWNDセッション追跡

2026-09-20に`src-tauri/src/launcher.rs`へ実装済み。`ShellExecuteExW`と`SEE_MASK_NOCLOSEPROCESS`で取得可能なプロセスを対象に、PID、HWND、プロセス開始時刻を`Arc<Mutex<...>>`の揮発共有Stateへ保持する。ハンドルはRAIIで`CloseHandle`し、PID/HWND/開始時刻/生存状態を再検証してから前面化する。HWND未取得、複数候補、Explorerまたは子プロセスへの委譲、終了、HWND消失、PID再利用の疑いは追跡不能として扱う。PID/HWNDは設定JSON、永続DTO、通常IPCレスポンスへ追加していない。

`launcher::tests`はPID/HWND PID不一致、HWND未取得・消失、複数候補、終了、PID再利用、委譲、Clone間の共有State、DTO/IPC非漏えいを含めて合格した。`cargo check`と`git diff --check`も合格。手動確認はtxt、PDF、フォルダ、HTMLファイルで完了し問題なし。Office文書は検証環境がないため未確認。COM/ROT、Restart Manager、タスクバー通知、診断ログは別差分のまま。

設定保存の実機確認では、保存済み設定の再起動復元、および編集中に`settings.json`の`revision`を外部変更した場合の`CONFIG_CONFLICT`を確認済み。画面には「別の変更と競合しました。編集内容は保持されています。」と表示され、編集中の内容が保持された。残りはOffice、WebView2、DnD、UNC/SMB、Windows/NTFS障害注入など、対応環境が整い次第実施する実機受入である。

### Phase 6: PDF protocolとPDF.js

1. `material://pdf/{material_id}`を現在の保存済み設定から毎回認可する。
2. GET/HEAD、単一Range、200/206/403/404/405/413/416、各必須ヘッダーを実装する。
3. 全体取得32 MiB、Range応答8 MiBの上限を実装する。
4. PDF.js 5.4.149 Workerをローカル同梱し、CDNと`unsafe-eval`を使わない。
5. `tauri.conf.json`へ承認済み候補CSPを反映する。dev用接続とproduction CSPを混同しない。
6. PDF切替時のcancel、generation更新、Canvas初期化、cleanup、destroyを実装する。
7. 暗号化、破損、fallback超過を他機能へ波及させない。

完了条件: protocol単体/統合試験とPDF切替自動試験が合格し、実機確認待ち項目が明示されている。

### Phase 7: Passive View UI

1. 設計書第6章を参考にするが、モックの状態・業務ロジックをコピーしない。
2. PresenterがRenderModelを作り、ViewはDOM、入力、フォーカス、ARIA、Canvasだけを扱う。
3. 全一覧再描画を避け、検索入力とリサイズを統合する。
4. 保存失敗時は編集内容を保持する。timeout、unknown、前面化拒否を成功色で表示しない。
5. キーボード操作、200%表示、長い名称、2,000件検索を確認する。

完了条件: SEC-01、UI-01～03、自動UI試験が合格し、主要操作をキーボードだけで実行できる。

### Phase 8: 実装後検証とリリース判定

1. CFG/WIN/PATH/PDF/SEC/UIの全必須ケースを実施する。
2. Windows 11 x64、M365 x64、WebView2 Stable、NTFS、制御可能なSMB共有を使用する。
3. Office ROT、前面化拒否、UNC停止、PDF Range/Worker/CSP、原子的置換障害を実測する。
4. 実施者、レビュー者、日時、環境、fixture hash、ログ、画面記録を保存する。
5. 不合格時は隠れた再試行や機能追加で回避せず、設計値・対応範囲を再レビューする。

完了条件: `ACCEPTANCE_TEST_ASSIGNMENT.md`の必須ケースが合格し、プロジェクトオーナーがリリースを承認する。

## 7. 操作性と性能の非交渉条件

- 起動中、保存中、同期中を明示し、同じ操作を連打させない。
- 保存失敗・競合で入力内容を消さない。
- UNC障害やPDF破損でメインUIをブロックしない。
- 前面化できない場合も外部アプリ起動済みの可能性と拒否理由を分けて表示する。
- 初期表示2秒、ローカル200件同期1秒、検索2,000件100 ms、PDF先頭2秒を計測目標とする。
- 目標未達をキャッシュで隠さず、cold/warm条件を分けて記録する。
- 待機時の定期ポーリングを追加しない。

## 8. セキュリティ不変条件

- 起動・前面化・保存場所表示・PDF配信は保存済みIDから解決する。
- JavaScriptから渡された任意パスやURLを実行しない。
- 設定編集で受けたpathも保存・実行前にRustで再検証する。
- URLはhttpsだけを許可する。
- DOM文字列は`textContent`を使い、HTMLとして挿入しない。
- shellの任意実行権限を追加しない。
- ログへ絶対パス、URL query、文書内容、PDF passwordを出さない。

## 9. テストコマンドの扱い

既存スクリプトを優先し、変更範囲に比例して実行する。

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Windows API、PDF/WebView2、UNC、障害注入は自動試験だけで合格扱いにしない。実機試験結果は`ACCEPTANCE_TEST_ASSIGNMENT.md`に対応付ける。

## 10. 最初の着手点

最初の実装ターンはPhase 0～2を対象とする。既存雛形と設計文書を確認し、DTO/AppError、共有fixture、Mediator/Event Chainの純粋試験までを完成させる。UI、Windows API、PDF protocol、永続化I/Oはこの最初の変更へ混ぜない。

Phase 0～2の完了後、差分、試験結果、未解決事項を報告してからPhase 3へ進む。
