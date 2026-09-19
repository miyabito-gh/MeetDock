# Phase 5 起動・Windows連携 実装記録

更新日: 2026-09-19

## 実装結果

- `activate_or_launch`、`batch_launch_main`、`open_containing_folder`をstrictな`{ request }` IPCとして登録した。
- requestは`material_id`または`group_id`だけを受ける。Rustは操作直前に保存済みschema 3設定を再読込・完全検証し、IDから対象を解決する。
- URLは保存時と実行時の設定再検証により`https`だけを許可し、OS関連付け起動後は`not_trackable`を返す。
- ファイル/フォルダ起動、Explorer表示、ウィンドウ検出、前面化を独立portへ分離し、モック試験可能にした。
- タイトル照合は正規表現を使用せず、NUL除去、前後/連続ASCII空白の正規化後にファイル名または最大128文字のヒントをリテラル部分一致する。候補0件は起動、1件は前面化、複数件は`unknown`相当として誤前面化も重複起動もしない。
- 前面化は有効HWND確認、最小化時だけ復元、`AttachThreadInput`のRAII解除、直前の再確認、1回の`SetForegroundWindow`、拒否時1回の点滅に限定した。拒否と消失を成功扱いにしない。
- 一括起動は設定上のmain資料をorder順に処理し、資料別失敗後も後続を継続して`LaunchResponse[]`を返す。
- AppErrorは固定メッセージのみを使用し、絶対パス、URL query、OS内部エラーを返さない。
- Tauri生成permissionを3コマンドへ追加し、local/main限定capabilityの契約試験対象にした。

## 自動試験

- WIN-04: `a[1]`等を正規表現として解釈せずリテラル照合し、複数候補では起動/前面化しない。
- WIN-05: https URLをOSへ渡し、成功を`not_trackable`として返す。
- WIN-06: 一括処理の先頭が失敗しても後続資料を起動する。
- 前面化拒否を`foreground_denied`、固定`FOREGROUND_DENIED`へ写像し、機微情報を含めない。
- strict envelope、main window限定、生成permission、ID-only DTOはRust/JavaScript契約試験で維持する。

## 未完了の実機検証と段階実装

- Microsoft 365 x64 Excel/WordのROT絶対パス検出は、この端末に対象Officeがなく未実装・未検証。現在は安全なタイトル候補照合へフォールバックする。
- Restart Manager候補取得は未実装。個別文書の確定判定には使用せず、追加時も独立Serviceとする。
- 2026-09-19、ユーザー判断によりOffice/Restart Managerの実装と検証は対応環境確保後へ延期し、次の実装対象をPhase 6とした。
- WIN-01～03（ROT同名別パス、前面化拒否/別デスクトップ/権限差）のWindows実機受入は未合格。
- WIN-04～06はモック/単体試験合格であり、既定ブラウザ、Explorer、実アプリタイトルを用いた製品相当buildの実機確認はPhase 8まで未検証とする。

以上の未完了項目があるため、Phase 5全体およびリリース判定を合格扱いにしない。
