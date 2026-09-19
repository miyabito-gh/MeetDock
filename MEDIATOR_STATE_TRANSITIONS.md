# Mediator状態遷移表

更新日: 2026-09-19
判定: **設計承認済み**

## 状態モデル

巨大な単一enumは採用せず、互いに独立する領域を持つ1個の`AppState`で管理する。これにより、編集中の同期やPDF表示を禁止せず、状態復帰のための複雑な履歴を持たない。

```text
AppState
├─ lifecycle: Booting | Ready | ReadOnly | RecoveryPending | MigrationPending | FatalError
├─ edit: Clean | Dirty | Saving | Conflict
├─ sync: Idle | Running(request_id)
├─ launch: idle/running material_id集合 + batch_group_id?
├─ pdf: Closed | Loading(material_id, generation) | Viewing(...) |
│       PasswordRequired(...) | Failed(material_id, code)
├─ config_revision: u64
└─ state_generation: u64
```

実行時状態は設定JSONへ保存しない。

## 識別子の使い分け

- `revision`: 設定保存専用。Rustが採番し、保存成功ごとに1増加する。
- `request_id`: UUID v4。重複し得る状態同期要求だけに使用し、最新要求以外の応答を破棄する。
- `state_generation`: JS内の`u64`相当の安全整数として0から単調増加する。設定の再読込、選択グループ変更、編集の破棄、PDF対象変更で増加し、非同期結果が発行時と同じ画面文脈か確認する。IPCへは送らない。
- `state_generation`がJavaScriptの安全整数上限へ達した場合は、進行中処理がない時点で0へ戻す。通常運用での到達は想定しない。

同期結果は`request_id`で判定する。保存競合は`revision`で判定する。PDF描画と画面限定通知は`state_generation`で判定し、互いに代用しない。

## 遷移

| 状態領域 | イベント | ガード | 更新 | Effect / 表示 |
|---|---|---|---|---|
| lifecycle=Booting | SettingsLoaded | schema=3、検証OK | Ready、edit=Clean | 初期RenderModel |
| lifecycle=Booting | FutureSchemaFound | schema>3 | ReadOnly | 保存・起動を無効化し理由表示 |
| lifecycle=Booting | LegacySettingsFound | legacy候補あり | MigrationPending | 移行確認表示 |
| lifecycle=Booting | CorruptSettingsFound | 候補有無を保持 | RecoveryPending | 復元・初期化・読取専用の選択表示 |
| MigrationPending | MigrationApproved | schema 3として検証可能 | Ready | SettingsServiceへ移行Effect |
| MigrationPending | MigrationRejected | 常時 | ReadOnly | 元ファイルを変更しない |
| RecoveryPending | RestoreSelected | 検証済みcandidate_id | Booting | 復元Effectを1回発行 |
| RecoveryPending | InitializeSelected | 明示確認済み | Booting | 初期化Effectを1回発行 |
| RecoveryPending | ReadOnlySelected | 常時 | ReadOnly | ファイル変更なし |
| edit=Clean | EditRequested | lifecycle=Ready | Dirty | 編集用RenderModel |
| edit=Dirty/Conflict | SaveRequested | lifecycle=Ready、入力検証OK | Saving | SaveSettings Effect |
| edit=Saving | SaveSucceeded | 応答が発行時generationと一致 | Clean、revision更新 | 保存完了表示 |
| edit=Saving | SaveConflict | 常時 | Conflict | 入力を保持し、再読込/取消を表示 |
| edit=Saving | SaveFailed | 常時 | Dirty | 入力を保持し、非破壊エラー表示 |
| edit=Dirty/Conflict | EditDiscarded | 明示確認済み | Clean、generation+1 | 保存済み値で再描画 |
| sync=Idle | SyncRequested | lifecycle=Ready/ReadOnly | Running(new request_id) | StatusService Effect |
| sync=Running | SyncRequested | 手動要求または新しい自動要求 | Running(new request_id) | 旧結果を失効、新Effect |
| sync=Running | SyncSucceeded/Failed | request_idが現在値と一致 | Idle | 結果またはエラーを反映 |
| sync=Running | SyncSucceeded/Failed | request_id不一致 | 変更なし | 応答を破棄、診断ログのみ |
| launch | ActivateRequested | lifecycle=Ready、登録ID、同ID未実行 | IDをrunningへ追加 | LaunchService Effect |
| launch | ActivateRequested | 同ID実行中 | 変更なし | 二重起動せず既存処理中を表示 |
| launch | LaunchSucceeded/Failed/ForegroundDenied | IDがrunning | IDをrunningから除去 | 結果反映。前面化拒否を成功扱いしない |
| launch | BatchLaunchRequested | lifecycle=Ready、同group未実行 | batch_group_id設定 | BatchLaunch Effect |
| launch | BatchLaunchCompleted/Cancelled | group一致 | batch_group_id解除 | 資料別結果を表示 |
| pdf | PdfOpenRequested | 登録済みPDF | Loading、新generation | PdfViewAdapterへURLとgenerationを渡す |
| pdf=Loading | PdfReady | material_idとgeneration一致 | Viewing | 表示 |
| pdf=Loading/Viewing | PdfOpenRequested | 別material_id | Loading、新generation | cancel→Canvas初期化→cleanup→destroy後に新規読込 |
| pdf=Loading | PdfPasswordRequired | generation一致 | PasswordRequired | パスワード入力または取消を表示 |
| pdf=Loading/Viewing | PdfFailed | generation一致 | Failed | 他領域を維持してエラー表示 |
| pdf | PdfReady/PdfFailed | generation不一致 | 変更なし | 古い結果を破棄 |
| lifecycle=ReadOnly | SaveRequested/ActivateRequested/BatchLaunchRequested | 常時 | 変更なし | `READ_ONLY_SCHEMA`を表示、副作用なし |
| 任意 | FatalError | 継続不能な内部不整合のみ | FatalError | 非破壊エラーと再起動導線 |

## ガードと副作用

- ガード失敗時は状態を変更せず、副作用を発行しない。
- Mediatorは状態を先に`Saving`、`Running`等へ変更してからEffectを返すため、同一操作の二重発行を防止できる。
- Effect Runnerは受け取ったEffectを各1回だけ実行し、自動再試行しない。再試行は利用者操作またはMediatorが明示した同期処理だけとする。
- 起動結果は外部アプリへの副作用が既に発生し得るため、世代不一致でも資料別の実行中状態は解消する。ただし古い画面文脈へトーストや選択変更を表示しない。
- `FatalError`は予期しない状態破損に限定し、通常のI/O、PDF、Windows API失敗には使用しない。

## 必須テスト

表の各行について正常遷移、ガード失敗、副作用数をテストする。特に保存競合、古い同期応答、PDF高速切替、同一資料二重起動、ReadOnlyでの禁止操作を独立ケースとする。

## レビュー記録

- 2026-09-19: プロジェクトオーナー指示に基づき、直交状態と有界な副作用モデルを承認。
