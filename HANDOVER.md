# MeetDock 引継ぎ（現行）

更新: 2026-10-29。詳細仕様は `MeetDock 基本・詳細設計書.md`、IPC契約は `IPC_CONTRACT.md`、状態遷移は `MEDIATOR_STATE_TRANSITIONS.md`、責務分離は `ARCHITECTURE_RESPONSIBILITY.md`、作業規則は `AGENTS.md`。過去の工程記録・検証ログ・長い引継ぎ文書は整理のため削除済み。必要なら git 履歴（コミット 723c906 の親、およびこの文書を追加するコミットの親）から復元できる。

## 実装状態

- Tauri v2 + Rust / Vite + Vanilla JS。Phase 0〜7（契約・Mediator・設定永続化・状態同期・起動/Windows連携・PDF protocol/PDF.js・UI）は実装済み。
- PDF画面: sidecar注釈（マーカー・Undo/Redo）、しおり左レール、日本語CMap同梱、資料切替ショートカット、全画面表示。
- 画面刷新は `src/screen-refresh.css` と `src/main.js`。
- `npm test` は 674 件すべて成功（2026-10-29）。

## 未完了・保留

- Acrobat Reader で開いているPDFの完全パス取得: 実機で未解決。ユーザー指示により保留。
- Office ROT / Restart Manager、WIN-01〜03、UNC/SMB の実機受入: 対応環境確保後へ延期。合格扱いにしない。
- 画面刷新の視覚的な最終受け入れ: 個別の合否・画面サイズは未報告。「問題なし」とは扱わない。
- 英語PDFの実機表示・検索: 未報告。中国語PDFの追加検証は不要とユーザーが指定。
- PDF画面のデザイン／操作性の見直し: 後続の改善候補（視認性、操作導線、左レールの幅と折りたたみ、狭幅レイアウト）。
- 配布・リリースは受入完了まで行わない。ビルドの500 KB超チャンク警告は既知。

## 実行方法

- 開発起動: `.\run.ps1 dev`、exe作成: `.\run.ps1 build`（出力 `src-tauri/target/release/meetdock.exe`）。Node.js 22以上、npm、Rust MSVC、WebView2が必要。初回は `npm ci`。
- テスト: `node --test tests/<対象>.test.mjs`、`cargo test --manifest-path src-tauri/Cargo.toml <名前>`。実機UIはユーザーの明示許可なしに起動しない。