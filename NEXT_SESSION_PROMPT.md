# MeetDock 次セッション引継ぎ指示

MeetDockの実装をPhase 7から継続してください。

## 作業開始時

1. `git status --short`と`git log -5 --oneline`を確認し、既存差分を破棄しないこと。
2. 現在のPhase 5第一段コミットは`3db3cdc feat: add bounded native launch commands (WIN-04 WIN-06)`。
3. 次の正本を上から順に読むこと。
   - `IMPLEMENTATION_HANDOFF.md`
   - `IPC_CONTRACT.md`
   - `MEDIATOR_STATE_TRANSITIONS.md`
   - `ARCHITECTURE_RESPONSIBILITY.md`
   - `PDF_RANGE_VERIFICATION.md`
   - `ACCEPTANCE_TEST_ASSIGNMENT.md`
   - `MeetDock 基本・詳細設計書.md`
4. 実装済み内容は`PHASE_0_2_IMPLEMENTATION.md`、`PHASE_3_IMPLEMENTATION.md`、`PHASE_4_IMPLEMENTATION.md`、`PHASE_5_IMPLEMENTATION.md`、`PHASE_6_IMPLEMENTATION.md`で確認すること。

## 現在の状態

- Phase 0～4は実装・自動試験済み。
- Phase 5第一段では`activate_or_launch`、`batch_launch_main`、`open_containing_folder`、保存済みID再解決、https/file/folder起動port、リテラルタイトル照合、制約付き前面化、一括継続を実装した。
- WIN-04～06と前面化失敗分岐のモック試験、strict envelope、local/main限定permission、ID-only DTO試験は合格している。
- Office ROTとRestart Managerは未実装。この端末にMicrosoft 365 x64の検証環境がないため、ユーザー判断で実機環境確保後へ延期した。Phase 5全体およびWIN-01～03を合格扱いにしないこと。
- PATH-03～05のACL/SMB実機受入も環境未登録のため未合格。
- 最新検証ではRust 43テスト、JavaScript 489テスト、Vite production build、`cargo check`、`git diff --check`が成功している。
- JavaScript側にはMediator、固定Event Chain、Effect Runner、IPC adapterとPDF切替adapterがある。古い非同期応答で現在表示を上書きしない契約を維持すること。

## Phase 6完了状況

`PHASE_6_IMPLEMENTATION.md`を参照してください。protocol、PDF.js adapter、Worker、候補CSPと自動試験は実装済みです。PDF-01/02/04/05およびWorker/CSPはWebView2実機未検証のため合格扱いにしません。

## 次の対象: Phase 7 Passive View UI

次を小さな変更単位で実装すること。

1. 設計書第6章を視覚参照に限定し、モックの状態・業務ロジックはコピーしない。
2. PresenterがRenderModelを作り、ViewはDOM、入力、フォーカス、ARIA、Canvasだけを扱う。
3. グループ/資料一覧、検索、編集、保存、一括/個別起動、状態表示、PDF Canvas/password UIを既存MediatorとServiceへ接続する。
4. 保存失敗時は編集内容を保持し、timeout、unknown、前面化拒否を成功色で表示しない。
5. 全一覧再描画を避け、検索入力とresizeを統合する。
6. キーボード操作、200%表示、長い名称、2,000件検索を自動/手動試験する。

完了条件はSEC-01、UI-01～03と自動UI試験の合格、主要操作のキーボード完結である。Phase 5延期項目やPhase 6実機受入を合格扱いにせず、UI変更へOffice/RM実装を混在させないこと。
