# MeetDock 実装前確認チェックリスト

更新日: 2026-09-19
対象: `MeetDock 基本・詳細設計書.md` v2.4

## 判定

**実装移行: 条件付き可（CONDITIONAL PASS）**

設計上の未決定事項は承認済み。2026-09-19のプロジェクトオーナー判断により、PDF/WebView2、Windows API、UNC、Windows原子的置換の実環境検証は本実装後へ移す。本実装は開始してよいが、これらを検証済みと表示せず、全件合格するまで配布・リリース不可とする。

## 確認状況

| 条件 | 状況 | 根拠/残課題 |
|---|---|---|
| Root起点の責務境界 | 承認済み | `ARCHITECTURE_RESPONSIBILITY.md` |
| Mediator状態・イベント | 承認済み | `MEDIATOR_STATE_TRANSITIONS.md` |
| Rust/JavaScript IPC契約 | 承認済み | `IPC_CONTRACT.md` |
| 永続化方針 | 設計承認済み | 実装後にNTFS障害注入を実施 |
| PDF Range基準 | 設計承認済み | 実装後にWebView2実機検証を実施 |
| Windows API範囲 | 設計承認済み | 実装後にM365/SMB実機検証を実施 |
| 受入試験の担当・方法 | 承認済み | `ACCEPTANCE_TEST_ASSIGNMENT.md` |

## 承認済みの主要判断

1. RootはComposition Root、Mediatorは純粋な状態遷移、Effect RunnerがServiceを1回だけ実行する。
2. Presenter間の転送チェーン、動的イベントバス、グローバル状態ライブラリは使わない。
3. Mediatorはlifecycle/edit/sync/launch/pdfの直交領域で管理する。
4. `revision`は保存、`request_id`は同期、`state_generation`は画面文脈に限定する。
5. 実行系IPCはIDのみ。設定編集IPCだけがパスを扱う。URLはhttpsのみ。
6. schema 3の未知フィールドは拒否し、将来schemaは推測せず読み取り専用とする。
7. 初期版は正規表現タイトル照合、管理者URL例外、Office 32-bit保証、強制前面化を行わない。
8. PDF全体取得は32 MiB、Range 1応答は8 MiB、不正/未知/非PDF IDは404とする。
9. UNCは2ワーカー、64件キュー、UI待機600 ms、30秒/10秒キャッシュとする。
10. 受入試験はロールで所有し、作成者と合否レビュー担当を分離する。

## 実装中の条件

- `IMPLEMENTATION_HANDOFF.md`の順序と各段階の完了条件に従う。
- UIより先にDTO、AppError、純粋状態遷移、設定検証を実装・自動テストする。
- Windows、PDF、UNC、永続化はService/Infrastructure境界の内側へ閉じ込め、モック可能にする。
- 未検証のWindows/PDF結果を成功扱いするフォールバックを作らない。
- CSPは現在`null`だが、PDF本実装と同時に承認済み候補を適用し、実機検証で確定する。
- 検証失敗時に新しい抽象化や常駐プロセスを安易に追加せず、対応範囲・数値を再レビューする。

## 実装後・リリース前の必須検証

1. `material://`、PDF.js 5.4.149、Range、Worker、CSPをWindows 11/WebView2実機で確認する。
2. Microsoft 365 x64 Excel/WordのROT、Restart Manager、タイトル照合、前面化拒否を実機で確認する。
3. SMB共有でUNC 2ワーカー、64件キュー、600 ms UI期限、timeout後の有界動作を確認する。
4. `ReplaceFileW`、`MoveFileExW`、3世代ローテーションを工程別障害注入で確認する。
5. CFG/WIN/PATH/PDF/SEC/UIの受入試験を実施し、証跡を保存する。
6. 現在の作業端末にはM365とSMB試験先がないため、条件を満たす別環境を用意する。

現在の作業端末ではx64、DisplayVersion 25H2、build 26200.9457、WebView2 Runtime 153.0.4234.46を読み取り確認済み。Office Click-to-Run登録と標準配置のExcel/Wordは未検出で、SMB試験先も未登録である。

## リリース条件

上記必須検証に実施環境、実施者、日時、結果、ログ/画面記録を付け、全件合格すること。不合格項目を既知制約として残す場合は、プロジェクトオーナーの明示承認と利用者向け制約記載を必須とする。

## レビュー記録

- 2026-09-19: 操作性、単純性、負荷上限を優先した設計を承認。
- 2026-09-19: プロジェクトオーナー判断により、実環境検証を本実装後へ移し、実装移行をCONDITIONAL PASSへ変更。
