# MeetDock 次セッション引継ぎ指示

MeetDockの実装をPhase 5から継続してください。

## 作業開始時

1. `git status --short`と`git log -5 --oneline`を確認し、既存差分を破棄しないこと。
2. 現在のPhase 4完了コミットは`f966137 feat: add bounded path status synchronization (PATH-01 PATH-05)`。
3. 次の正本を上から順に読むこと。
   - `IMPLEMENTATION_HANDOFF.md`
   - `IPC_CONTRACT.md`
   - `MEDIATOR_STATE_TRANSITIONS.md`
   - `ARCHITECTURE_RESPONSIBILITY.md`
   - `WINDOWS_API_VERIFICATION_PLAN.md`
   - `ACCEPTANCE_TEST_ASSIGNMENT.md`
   - `MeetDock 基本・詳細設計書.md`
4. 実装済み内容は`PHASE_0_2_IMPLEMENTATION.md`、`PHASE_3_IMPLEMENTATION.md`、`PHASE_4_IMPLEMENTATION.md`で確認すること。

## 現在の状態

- Phase 0～4は実装・自動試験済み。
- Phase 4では`sync_material_statuses`、保存済みIDからのパス解決、ローカル/UNC分離、専用2ワーカー、64件キュー、同一パス統合、600 ms期限、30/10秒キャッシュを実装済み。
- JavaScript側にはMediator、固定Event Chain、Effect Runner、IPC adapterがあり、古い`request_id`の同期応答は破棄される。
- Phase 4完了時点でRust 35テスト、JavaScript 484テスト、Vite production buildが成功している。
- PATH-03～05のACL/SMB実機受入は環境未登録のため未合格。自動試験だけで合格扱いにしないこと。

## 次の対象: Phase 5 起動・Windows連携

次を小さな変更単位で実装すること。

1. `activate_or_launch`、`batch_launch_main`、`open_containing_folder`をstrict native IPCとして実装する。
2. requestは保存済み`material_id`または`group_id`だけを受け、JavaScriptから任意パスやURLを実行させない。
3. Rust側で現在の保存済み設定を再読込し、IDから対象を解決する。
4. https URL、ファイル、フォルダの起動処理を薄いport/traitの内側へ置き、モック可能にする。
5. 同一資料と同一グループの二重起動は既存Mediatorのガードを維持する。
6. 一括起動は途中の資料が失敗しても残りを継続し、資料別`LaunchResponse`を返す。
7. Excel/Word ROT、Restart Manager補助情報、ウィンドウタイトルのリテラル照合、前面化処理を別Serviceとして段階的に実装する。
8. 前面化は有効HWND確認、最小化復元、RAIIでの`AttachThreadInput`解除、1回の前面化試行、必要なら1回の点滅に限定する。
9. 候補複数、権限差、別デスクトップ、HWND消失、前面化拒否を成功扱いにしない。
10. `AppError`や表示用detailへ絶対パス、URL query、OS内部エラー文字列を含めない。

## 初期版の対象外

- Office 32-bit、永続ライセンス版Office、PowerPointのROT保証
- ウィンドウタイトル正規表現
- http URL、独自スキーム、任意shellコマンド
- キー入力偽装、連続前面化、強制デスクトップ切替
- 隠れた自動再試行や定期ポーリング

## Phase 5完了条件

- WIN-04～06とWindows API分岐のモック試験が合格すること。
- IPCのlocal/main限定permissionとstrict envelopeを試験すること。
- 起動系requestに実パスやURLのフィールドが存在しないことを契約試験で維持すること。
- `npm test`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo check --manifest-path src-tauri/Cargo.toml`、`git diff --check`を実行すること。
- Microsoft 365や前面化制約の実機確認ができない場合は、未検証として明記し合格扱いにしないこと。
- 実装結果と残課題を`PHASE_5_IMPLEMENTATION.md`へ記録し、`PROJECT_HANDOVER.md`を更新すること。
- 受入IDを含む小さなコミットとして保存し、勝手にpushやリリースをしないこと。

まず既存コードと正本を確認し、Phase 5のWindows依存処理をモック可能な境界へ分けてから実装・試験まで進めてください。確認だけで止まらず、安全に判断できる範囲は自律的に完了してください。
