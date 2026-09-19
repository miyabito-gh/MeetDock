# IPC DTO・エラーコード契約

更新日: 2026-09-19
判定: **設計承認済み**

## 共通規則

- JSONのフィールド名とenum値はすべて`snake_case`とする。
- `revision`と`expected_revision`はJSON整数`0..=9,007,199,254,740,991`（JavaScriptの安全整数）に制限する。Rust内部型は`u64`でも、この上限を超えて保存しない。
- IDはASCIIの`[A-Za-z0-9_-]{1,64}`、`request_id`はUUID v4文字列とする。
- 日時はUTCのRFC 3339文字列とし、Rustが生成する。
- schema 3の未知フィールド、必須フィールド欠落、型不一致、未知enumは`VALIDATION_ERROR`とする。
- `null`を許可するのは明示的に`T | null`と記載したフィールドだけとし、省略は許可しない。
- schema判定は完全なDTOデコードより先に行う。`schema_version > 3`はschema 3としてデコードせず、読み取り専用起動情報を返す。
- 初期リリース前のため旧IPCクライアント互換は持たない。Rust/JavaScriptを同一リリース単位で更新する。

## 設定DTO

```text
AppConfig {
  schema_version: 3,
  app_version: string,
  revision: u64,
  last_updated: RFC3339 string,
  groups: GroupItem[],
  materials: MaterialItem[]
}

GroupItem {
  id: string,
  parent_id: string | null,
  name: string,
  order: u32
}

MaterialItem {
  id: string,
  group_id: string,
  name: string,
  role: "main" | "reference",
  target_type: "file" | "folder" | "url",
  path: string,
  window_match_pattern: string | null,
  order: u32
}
```

`window_match_pattern`はschema 3では正規表現ではなく、最大128文字の任意のリテラルタイトルヒントとして扱う。正規表現評価は行わない。空文字は`null`へ正規化する。

Phase 3の業務検証では、group/materialそれぞれのID一意性、参照先存在、非循環、空白のみでない名称を必須とする。orderはgroupの同一parent内、materialの同一group/role内で1からの連番（配列自体の並び順は不問）。不正順序を保存時に黙って振り直さない。

file/folderはドライブ絶対パスまたはserver/share付きUNC（対応する`\\?\`形式を含む）を字句検証する。区切り`/`も許可する。相対/ドライブ相対、device namespace、ADS、`.`/`..`、空の中間要素、末尾ドット/空白、Win32予約名・禁止文字を拒否する。パスの存在確認やUNC I/Oはこの検証では行わない。原文を保持し、実行時の比較用正規化は後続Phaseで行う。

## 起動時設定DTO

```text
SettingsLoadResponse {
  mode: "ready" | "migration_required" | "recovery_required" |
        "read_only_future_schema" | "read_only_unavailable",
  config: AppConfig | null,
  source_schema_version: u32 | null,
  candidates: SettingsCandidate[],
  notice_code: string | null
}

SettingsCandidate {
  candidate_id: string,
  kind: "backup" | "legacy" | "temporary",
  revision: u64 | null,
  last_updated: RFC3339 string | null
}
```

候補の実パスはJavaScriptへ返さない。将来schemaや全候補破損時は`config=null`とし、設定内容を部分的に推測して表示しない。

## コマンド契約

| command | request | response |
|---|---|---|
| `load_settings` | `{}` | `SettingsLoadResponse` |
| `resolve_settings_issue` | `{ action, candidate_id }` | `SettingsLoadResponse` |
| `save_settings` | `{ config: AppConfig, expected_revision: u64 }` | `{ revision: u64, last_updated: RFC3339 }` |
| `sync_material_statuses` | `{ material_ids: string[], request_id: UUID }` | `{ request_id: UUID, results: MaterialStatusResult[] }` |
| `activate_or_launch` | `{ material_id: string }` | `LaunchResponse` |
| `batch_launch_main` | `{ group_id: string }` | `{ results: LaunchResponse[] }` |
| `open_containing_folder` | `{ material_id: string }` | `{}` |
| `prepare_dropped_files` | `{ paths: string[] }` | `{ candidates: { name, path }[] }` |

Tauri commandは`load_settings`を除き、表のrequest全体を単一引数`request`として受ける。JavaScriptは`invoke(command, { request })`を使用し、コマンドごとの引数名変換へ依存しない。

`resolve_settings_issue.action`は`restore_candidate`、`import_legacy`、`initialize_empty`、`open_read_only`のいずれか。candidateが不要なactionでは`candidate_id=null`、必要なactionでは登録済みcandidate IDを必須とする。

`save_settings`では`config.revision == expected_revision`を必須とする。RustはMutex取得後にディスク上のrevisionを再読込して比較し、成功時だけJavaScript安全整数の範囲内で1増加させる。上限到達は`VALIDATION_ERROR`とする。`last_updated`と`app_version`の保存値はRust側で確定する。

### Phase 3の設定処理補足

- commandのJSON envelopeも検証する。loadは`{}`、他は`{ request }`だけ。native commandではraw JSONを受け、`decode`/`Validate`へ渡す。型デコードだけで検証完了とはしない。Tauriの生成permissionをlocal/main capabilityだけに付与する。
- pristine起動（current、復旧用残存ファイル、有効legacy候補が全てない場合）は空設定revision 0を初回保存する。currentがないだけでは初期化せず、backup/tempが存在する場合は破損していても復旧選択を要求する。
- 正常currentを優先する。currentが破損/欠落の場合にbak1〜3、bak.new、temp、ReplaceFileW退避ファイルを完全検証して候補化する。候補はrevision降順。同revisionはファイル名順で安定化するが、名前/実パスはDTOへ公開しない。
- candidate IDは読込ごとの不透明なセッショントークン。選択時に再読込・完全検証・提示時のbyte列との一致確認を行う。候補の差し替え/失効は拒否し、自動復元しない。
- 復元/旧試作移行は候補revisionを維持し、明示初期化は0とする。いずれも日時/アプリ版はRustが確定する。revision+1は通常の`save_settings`だけに適用する。
- 旧試作候補はcurrentも復旧残存ファイルもない場合だけ提示する。元ファイルは変更せず、import_legacy以外で移行しない。open_read_only後はセッション終了まで再提示・保存・復旧を禁止する。schema 1/2も将来schemaも自動migrationしない。
- 読込時に将来/旧schemaを検出したセッションも読み取り専用を維持する。復旧承認後にcurrentが変わっていれば競合とし、未知schemaに変わっていればREAD_ONLY_SCHEMAで拒否する。読み取りのI/Oエラーは破損/不存在と区別し、初期化しない。
- 保存のMutexはblocking処理の完了まで所有する。最終置換の直前にもcurrentのbyte列を再確認するが、外部プロセスとのOSレベルCASではない。アプリの単一プロセス前提は変えない。
- ReplaceFileW成功をcommit点とする。成功後の残存退避ファイル削除失敗で保存失敗へ戻さない。ReplaceFileWの1177等ではcurrent名が失われ得るため、明示退避先と検証済みbackup/tempで旧/新内容を保護してCONFIG_IOを返す。無断の復元やMoveFileExWへの置換再試行はしない。詳細は基本・詳細設計書2.3とCFG_01_VERIFICATION.mdを参照。

## 状態・起動DTO

```text
MaterialStatusResult {
  material_id: string,
  open_state: "open" | "not_detected" | "unknown" | "not_trackable",
  confidence: "exact" | "estimated" | "unknown",
  path_state: "exists" | "missing" | "timeout" | "access_denied" |
              "unchecked" | "error",
  detail: string | null
}

LaunchResponse {
  material_id: string,
  outcome: "activated" | "launched" | "not_trackable" |
           "foreground_denied" | "not_found" | "failed",
  error: AppError | null
}
```

`LaunchResponse`から重複する`success`と自由文`message`を除く。`outcome`が`activated`、`launched`、`not_trackable`なら`error=null`、それ以外は`error`必須とする。一括起動の資料別失敗は正常な`BatchLaunchResponse`内へ格納し、コマンド全体の`Err`は要求全体を処理できない場合だけに使用する。

## AppError

```text
AppError {
  code: ErrorCode,
  message: string,
  material_id: string | null,
  retryable: boolean
}
```

`message`はパス、URLクエリ、OS内部文字列を含まない短いユーザー表示用日本語とする。内部詳細は診断ログだけへ記録する。`retryable`は「同じ入力を直ちに再送してよい」ことを示し、コードごとに固定する。

| code | 用途 | retryable |
|---|---|---|
| `INVALID_REQUEST` | ID、UUID、必須値など要求形式が不正 | false |
| `VALIDATION_ERROR` | schema 3の設定内容が不正 | false |
| `CONFIG_CONFLICT` | 保存revision競合 | false |
| `CONFIG_CORRUPT` | 現行設定を解釈できない | false |
| `CONFIG_IO` | 設定I/Oが一時的に失敗 | true |
| `READ_ONLY_SCHEMA` | 読み取り専用中の変更要求 | false |
| `NOT_FOUND` | 登録IDまたは対象が存在しない | false |
| `ACCESS_DENIED` | OSまたはファイル権限拒否 | false |
| `PATH_TIMEOUT` | UNC検査のUI期限超過 | true |
| `PATH_QUEUE_BUSY` | UNCキュー満杯 | true |
| `UNSUPPORTED_TARGET` | 初期版対象外の形式・操作 | false |
| `WINDOW_NOT_FOUND` | 対象ウィンドウが消失・未検出 | true |
| `FOREGROUND_DENIED` | Windowsが前面化を拒否 | false |
| `LAUNCH_FAILED` | OS起動要求が失敗 | true |
| `PDF_RANGE_INVALID` | Range形式または範囲が不正 | false |
| `PDF_NOT_ALLOWED` | 登録済みPDFとして認可できない | false |
| `PDF_NOT_READABLE` | 登録PDFを読み取れない | false |
| `PDF_PASSWORD_REQUIRED` | 暗号化PDFにパスワードが必要 | false |
| `PDF_CORRUPT` | PDF構造が破損 | false |
| `PDF_FALLBACK_TOO_LARGE` | 全体取得上限を超過 | false |
| `INTERNAL_ERROR` | 予期しない内部不整合 | false |

## パスとURLの境界

- `activate_or_launch`、`batch_launch_main`、`open_containing_folder`、`material://`は`material_id`または`group_id`だけを受け、実パスや任意URLを受けない。
- Rustは実行直前に保存済み設定から対象を引き、種別、絶対パス、許可スキームを再検証する。
- `load_settings`と`save_settings`は設定編集用であるため`path`を含む。この例外を実行系IPCへ流用しない。
- `prepare_dropped_files`はネイティブDnD入力専用であり、Rustが存在する通常ファイルをcanonicalizeして登録候補を返す。候補は確認後にのみdraftへ追加し、起動系IPCへは渡さない。
- 初期版で起動を許可するURLは`https`だけとする。`http`、`file`、`javascript`、`data`、その他の独自スキームは拒否し、管理者例外機能は実装しない。

## 競合規則

- `revision`、`request_id`、`state_generation`を相互に代用しない。
- 同期応答の`request_id`は要求値と完全一致させる。古い応答は表示・エラーとも破棄する。
- 起動系はMediatorの実行中集合で同一IDを合流させる。IPCに不要な相関IDは追加しない。
- 未知フィールドを黙って無視せず、schemaを上げて契約を変更する。

## レビュー記録

- 2026-09-19: プロジェクトオーナー指示に基づき、初期版の契約を上記へ固定。
