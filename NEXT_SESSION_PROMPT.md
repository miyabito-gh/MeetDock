# MeetDock 次セッション引継ぎ

MeetDockの画面刷新を最終確認してください。作業基準は C:\Users\wmasa\Documents\Rust\MeetDock、ブランチは codex/meetdock-screen-review です。推奨モデル: gpt-6-sol / medium。理由: 変更はCSS中心で、自動検証済みの画面を限定的に受け入れ確認する作業だからです。Astraは使用しないでください。

完了条件:
- src/screen-refresh.css と src/main.js の変更を読み、既存画面の階層、一覧、PDFプレビュー、ウィンドウ管理、復旧／編集ダイアログを確認する。
- 画面の目視確認が必要なら、開始前にユーザーの明示許可を得る。許可がない間はTauri、開発サーバー、ブラウザー等を起動しない。
- 実機確認が許可された場合、通常幅、狭い一覧＋PDFペイン、ウィンドウ一覧、設定復旧／編集ダイアログで視認性、操作優先順位、フォーカス、狭幅レイアウトを確認する。確認できない項目は未確認と記録する。
- 実際に見つかった問題だけを限定修正する。既存のRust変更を保持し、無関係な整理へ広げない。

実施済み:
- 青緑と霧色を基調に、メイン資料一覧、PDF、ウィンドウ／操作ダイアログを揃えた。
- 共通モーダルの余白衝突、狭いPDFペインの状態列、未使用セレクタ、狭幅のツールバー配置を見直し、ブランド印に製品固有の形を加えた。
- サブエージェントの独立レビューを反映した。
- node --test tests/view.test.mjs は67件成功。npm run build 成功（500 KB超のチャンク警告あり）。git diff --check 成功。
- 実機UIは未起動。視覚的な最終受け入れは未確認。

対象ファイル: src/screen-refresh.css、src/main.js。開始時に git status --short と対象差分を確認し、他の変更を保持する。必要なコード修正後は node --test tests/view.test.mjs、npm run build、git diff --check を実行する。通常の確認・修正ではコミット／pushしない。
