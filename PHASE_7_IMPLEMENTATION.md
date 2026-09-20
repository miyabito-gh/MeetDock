# Phase 7 実装記録: Passive View UI

更新日: 2026-09-19

## 実装した範囲

- `Root → Presenter → Passive View` の依存方向を維持し、既存Mediator／Effect Runner／IPC adapterへ本番UIを接続した。
- 設計書第6章のモックを視覚仕様として、250pxサイドバー、52pxトップバー、メイン／参考の2セクション、5列資料表、ステータスバッジ、右側PDFペイン、配色とレスポンシブ挙動を再現した。
- グループと資料の一覧、全グループ検索、グループ選択、資料名・パス／URL・グループ名編集、保存、破棄、再読込、状態同期、個別／一括起動を接続した。
- PDF Canvas、切替、閉じる操作、都度入力のpassword UIを既存`PdfViewAdapter`へ接続した。
- グループの新規／子追加、名前変更、空グループ削除、親子階層表示、マウス／キーボードコンテキストメニューを実装した。
- 資料の追加／編集モーダル／削除、メイン・参考切替、file・folder・url変更、グループ移動を実装した。変更のたびに同一group/role内の`order`を1始まりの連番へ保つ。
- 「保存場所を開く」は保存済み`material_id`だけを既存IPCへ渡す。未保存資料とDnDの実パスは実行系IPCへ渡さない。
- Tauri `onDragDropEvent`でWindowsネイティブDnDを受け、専用IPCでRust側のcanonicalizeと通常ファイル／フォルダ検証を通した候補だけを一括確認画面へ表示する。フォルダ配下は展開しない。利用者が区分と登録先グループを確定した後に未保存draftへ追加し、保存時は既存schema 3検証を通る。
- PDFの前後ページ、拡大／縮小、幅合わせ、最大化、280～800 pxペインリサイズをPresenter→Mediator→Effect Runner→`PdfViewAdapter`へ接続した。既存のgeneration guardとcancel→Canvas初期化→cleanup→destroyを維持する。
- サイドバー折りたたみ、180～450 px幅変更、PDF幅変更、window resize通知をMediatorへ統合した。
- 破損設定のバックアップ選択、確認付き初期化、旧設定migration承認／拒否、将来schema／利用不能設定の読み取り専用表示を既存Phase 2～3状態遷移とEffectへ接続した。
- 動的な表示文字列は`textContent`またはフォームの`value`だけで反映し、HTMLとして解釈しない。
- 資料行とグループはIDをキーに既存DOMを再利用し、検索・状態更新のたびに一覧コンテナ全体を作り直さない。
- `Ctrl+F`検索、ネイティブbutton/input、ARIA live region、可視フォーカス、狭幅レイアウトを実装した。
- 保存失敗・競合時はMediatorのdraftを保持し、未保存表示、再試行、破棄、再読込の導線を維持する。
- timeout、unknown、前面化拒否、起動失敗、PDF失敗を成功色にしない。
- `PDF_FALLBACK_TOO_LARGE`、非対応暗号方式を含む読取不能、破損時は「外部アプリで開く」を表示し、保存済み`material_id`だけを既存`activate_or_launch`経路へ渡す。起動結果は既存Mediatorの成功・失敗通知で表示する。

## UI情報階層の追加改善

- `Clean`では保存状態を表示せず、`Dirty`／`Saving`／`Conflict`だけをタイトル横へ表示する。
- 上部ツールバーを編集操作、補助操作、主要操作へ分割し、状態更新、並べ替え、資料追加、メイン資料起動の位置を編集状態から独立させた。
- 資料状態は小さな点または警告記号とテキストへ軽量化し、色だけに依存しない`aria-label`を付与した。
- MeetDockの「アクティブにする」思想を優先し、ファイル種別アイコンを既存`activate_or_launch`経路へ接続した。既存ウィンドウがあれば前面化し、見つからなければ外部アプリで起動する。
- 「…」メニューにも「外部で開く」を残した。行操作は右端起点で詰め、「…」を常に最右端、PDFプレビューをPDF行だけその左に配置した。
- 上記変更後、関連JavaScriptテスト31件、Vite production build、`git diff --check`が合格した。

## 自動試験

- JavaScript 496 tests: 合格（Phase 7追加7件）
- Rust 43 tests: 合格
- Vite production build: 合格
- `git diff --check`: 合格

Phase 7追加試験では、2,000件検索が100 ms以内で完了して所属グループを検索対象に含むこと、危険な表示名をHTMLへ注入しないこと、失敗・timeout・unknown・前面化拒否を成功色にしないことを確認した。加えてCRUD後のschema 3連番、DnD draftとID-only実行境界、レイアウト境界、PDF操作のMediator経由、Ctrl+F／ContextMenu／Shift+F10／Escapeを確認した。

## 未検証・残課題

- UI-03のWindows 11/WebView2実機によるキーボード完結、200%表示、フォーカス順の手動受入
- 長い名称と実データ2,000件を使ったWebView2描画時間の手動計測
- PDF Canvas/password UIおよびproduction CSPのWebView2実機受入
- Windows/WebView2実機でのネイティブDnD（Tauriイベント登録と自動契約試験は実装済み）
- Phase 5のOffice ROT／Restart ManagerとPhase 6の実機項目

自動試験範囲は完了したが、UI-03とWebView2実機項目が残るため、Phase 7全体およびリリース判定を合格扱いにしない。
