# MeetDock 次セッション引継ぎ指示

MeetDockの実装をPhase 6から継続してください。

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
4. 実装済み内容は`PHASE_0_2_IMPLEMENTATION.md`、`PHASE_3_IMPLEMENTATION.md`、`PHASE_4_IMPLEMENTATION.md`、`PHASE_5_IMPLEMENTATION.md`で確認すること。

## 現在の状態

- Phase 0～4は実装・自動試験済み。
- Phase 5第一段では`activate_or_launch`、`batch_launch_main`、`open_containing_folder`、保存済みID再解決、https/file/folder起動port、リテラルタイトル照合、制約付き前面化、一括継続を実装した。
- WIN-04～06と前面化失敗分岐のモック試験、strict envelope、local/main限定permission、ID-only DTO試験は合格している。
- Office ROTとRestart Managerは未実装。この端末にMicrosoft 365 x64の検証環境がないため、ユーザー判断で実機環境確保後へ延期した。Phase 5全体およびWIN-01～03を合格扱いにしないこと。
- PATH-03～05のACL/SMB実機受入も環境未登録のため未合格。
- 最新検証ではRust 39テスト、JavaScript 484テスト、Vite production build、`cargo check`、`git diff --check`が成功している。
- JavaScript側にはMediator、固定Event Chain、Effect Runner、IPC adapterとPDF切替用の世代ガード骨格がある。古い非同期応答で現在表示を上書きしない契約を維持すること。

## 次の対象: Phase 6 PDF protocolとPDF.js

次を小さな変更単位で実装すること。

1. `material://pdf/{material_id}`を登録し、要求ごとに現在の保存済み設定を再読込してIDを認可する。
2. 許可対象を`target_type=file`、`.pdf`拡張子、通常ファイル、読取可能、先頭1024 byte以内に`%PDF-`がある資料へ限定する。
3. URLデコードは1回だけとし、IDの完全一致、query/fragment/余分なパス要素/二重エンコード/トラバーサルを拒否する。実パスをJavaScriptへ公開しない。
4. GET/HEADだけを許可し、200/206/403/404/405/413/416と必須ヘッダーを`PDF_RANGE_VERIFICATION.md`どおり実装する。
5. 単一Rangeの`start-end`、`start-`、`-suffix`を扱い、複数Rangeや不正Rangeを416にする。整数オーバーフローを防ぐ。
6. 全体取得は32 MiB、1回のRange応答は8 MiBを上限とする。大容量ファイルを全読み込みしないport/reader境界と試験を作る。
7. `pdfjs-dist` 5.4.149の`pdf.worker.min.mjs`をローカル同梱し、CDN、data URL、実行時ダウンロード、`unsafe-eval`を使わない。
8. `tauri.conf.json`へ承認済み候補CSPを反映する。production CSPとdev接続要件を混同せず、必要最小限を維持する。
9. `PdfViewAdapter`で切替時の`renderTask.cancel()`、generation更新、Canvas初期化、`cleanup()`、`destroy()`、新規loadの順序を守る。
10. password callbackは都度入力とし、保存・ログ・自動再試行をしない。3回失敗または取消で当該プレビューを終了する。
11. 暗号化、破損、fallback超過、古いcallbackを他資料・同期・編集へ波及させない。

## 初期版の対象外

- 複数Range応答
- 32 MiBを超えるRangeなし全体取得
- PDF CDN、外部Worker、実行時Worker取得
- `unsafe-eval`、`unsafe-inline`
- password保存、隠れた自動再試行
- Phase 5のOffice ROT／Restart ManagerをPDF変更へ混在させること

## Phase 6完了条件

- PDF-03のprotocol単体/統合試験が合格し、GET/HEAD、Range境界、open-ended、suffix、不正・複数Range、0 byte、上限、全必須ヘッダーを確認すること。
- 未登録ID、非PDF、query/fragment、トラバーサル、アクセス拒否で内容や実パスを漏らさないこと。
- PDF切替自動試験で最後の資料だけが表示され、cancel/cleanup/destroy順、古いgeneration破棄、未処理Promise rejectionなしを確認すること。
- Workerがproduction buildへ同梱され、CSPにCDN、`unsafe-eval`、`unsafe-inline`がないことを静的試験すること。
- `npm test`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo check --manifest-path src-tauri/Cargo.toml`、`git diff --check`を実行すること。
- WebView2実機でRange/Worker/CSP、128 MiB PDF、暗号化・破損PDFを確認できない項目は未検証と明記し、自動試験だけでPDF-01/02/04/05を合格扱いにしないこと。
- 実装結果と残課題を`PHASE_6_IMPLEMENTATION.md`へ記録し、`PROJECT_HANDOVER.md`を更新すること。
- 受入IDを含む小さなコミットとして保存し、勝手にpushやリリースをしないこと。

まずTauri v2の既存設定と現在固定されている`pdfjs-dist`のアセット構成を確認し、Range計算・認可・ファイル読取を純粋/モック可能な境界へ分けてください。その後protocol、PDF.js adapter、CSPの順で実装・試験まで進め、確認だけで止まらないでください。
