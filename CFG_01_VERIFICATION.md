# CFG-01 Windows/NTFS障害注入手順

作成: 2026-09-19 / Codex。本書の実機障害試験は**未実施**。
通常保存の自動試験とハーネスのsmoke確認は完了したが、強制終了、ACL、共有違反、電源断耐性、独立合否レビューの合格を意味しない。

## 対象と安全境界

- `src-tauri/examples/cfg01.rs`を専用test harnessとして使用する。製品には組み込まない。
- 保存先を引数で受け取らない。`seed`が生成する32桁RUN_IDから`%TEMP%/MeetDock-CFG01-{RUN_ID}`だけを解決する。
- ディレクトリのmarker、直接のTEMP配下であること、symlinkでないことを確認してから操作する。既存のAPPDATA設定・旧試作設定は読まない。
- seedは`meetdock-cfg01-v1`。100グループ/500資料の生成データ。current=12、bak1=11、bak2=10、bak3=9。資料パスは文字列のみで実ファイルを開かない。
- 各ケースで新たにseedする。過去の結果を上書きしない。ハーネスは試験データを自動削除しない。
- Windows 11 x64、NTFS SSD、一般ユーザー権限で実施。TEMPのファイルシステムがNTFSであることを確認する。

## 準備と通常保存

リポジトリ直下のPowerShellで:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --example cfg01
& ./src-tauri/target/debug/examples/cfg01.exe seed
# 表示されたRUN_IDを設定（パスを渡さない）
$cfg01Run = '表示された32桁RUN_ID'
& ./src-tauri/target/debug/examples/cfg01.exe save $cfg01Run
& ./src-tauri/target/debug/examples/cfg01.exe inspect $cfg01Run
```

通常保存はrevision=13、bak1=12、bak2=11、bak3=10。`inspect`は通常起動と同じConfigManagerで、mode/current_revisionと候補DTOだけを表示する。

2026-09-19のsmoke記録: RUN_ID `612067e386d947d3a69c7e3710d511d0`、通常保存13、再読込ready/13。ログは`artifacts/phase-3-harness.log`（gitignore対象）。この1回のsmokeはCFG-01実機障害試験の代替ではない。

## 工程別プロセス終了

1. ケースごとに`seed`し、新しいRUN_IDを控える。
2. 次のように保存を開始し、`PAUSED`表示と専用ハーネスのPIDを待つ。

```powershell
& ./src-tauri/target/debug/examples/cfg01.exe save $cfg01Run TempSync
```

3. 別のPowerShellで表示されたPIDのプロセス名が`cfg01`、実行パスがこのリポジトリのexampleであることを確認し、そのPIDだけを`Stop-Process -Id <確認したPID> -Force`で終了する。他のMeetDockやユーザー作業プロセスを終了しない。
4. fixtureディレクトリ内の全ファイル名、サイズ、SHA-256を採取してから`inspect`する。再起動で勝手に候補がcurrentへ昇格していないことを確認する。
5. currentが検証可能なら元revision（commit前は12、commit後は13）を使用する。current欠落/破損時は検証済み候補だけをrevision降順で提示し、未検証/部分書込ファイルを除外する。
6. 候補が必要な場合は、明示選択を試す。INDEXはinspect表示の0始まり位置。restore内部で再度loadし、そのセッションで発行したIDを使用する。

```powershell
& ./src-tauri/target/debug/examples/cfg01.exe restore $cfg01Run 0
& ./src-tauri/target/debug/examples/cfg01.exe inspect $cfg01Run
```

checkpointは各工程の**直前**。次のcheckpointは前工程完了後でもある。Enterは処理続行（故障なし）なので、終了ケースでは押さない。

| 停止名 | 到達時点 | 終了後の必須条件 |
| --- | --- | --- |
| ReadCurrent / CreateDirectory / TempWrite | 保存準備前 | current=12保持 |
| PartialTemp | tempの半分を書いてsync済み | current=12、tempは候補除外 |
| TempSync | temp全書込後、sync前 | current=12保持、tempは再検証してから候補化 |
| TempVerify | temp sync後 | current=12、temp完全検証可能 |
| BackupWrite / BackupSync / BackupVerify | backupコピー前/後/同期後 | current=12、破損backupは候補除外 |
| RotateThree / RotateTwo / RotateOne | それぞれbak2→3、bak1→2、bak.new→1の直前 | current=12、途中の世代欠落/重複で無断復元しない |
| BeforeCommit / Replace | 準備済み/ReplaceFileW直前 | current=12、検証済みtemp=13とbak1=12保持 |
| Committed | OS置換成功直後・IPC応答前 | current=13、残存退避はあってよい |
| Cleanup | commit後・退避削除前 | current=13、cleanup失敗を保存失敗へ戻さない |
| FirstMove | 初回MoveFileExW直前 | `seed-empty`を使用。currentなし、temp=0を明示候補にする |

FirstMove専用ケース:

```powershell
& ./src-tauri/target/debug/examples/cfg01.exe seed-empty
$cfg01Run = 'このseed-emptyのRUN_ID'
& ./src-tauri/target/debug/examples/cfg01.exe save $cfg01Run FirstMove
```

## OS実エラーの注入

- **共有違反**: `Replace`で停止後、fixtureのsettings.jsonだけを別のPowerShell/.NET FileStreamで`FileShare.None`として開き、Enterで処理続行。CONFIG_IO、旧currentとtemp保持を確認。ハンドルを閉じて再読込・明示再試行。
- **backupローテーション失敗**: 対応checkpointで停止し、移動先bak1/2/3だけを共有削除不可のハンドルで保持する。current無変更、CONFIG_IOを確認。
- **ACL拒否**: fixtureの対象ファイル/専用ディレクトリだけに試験用拒否ACLを設定。元ACLを記録し、試験後はそのfixtureだけ復元する。APPDATAやTEMP全体のACLは変更しない。読込拒否を不存在やCONFIG_CORRUPTと誤認して初期化しないことも確認。
- **容量不足/ストレージ障害**: 隔離したNTFS試験VM/ボリュームを使用。試験ボリュームのTEMPで新規seedし、部分書込/sync失敗を注入する。開発端末の通常ドライブを埋めない。
- **電源断/OSクラッシュ**: 必要な耐久性判断は隔離VM/試験端末で実施。プロセス終了だけで物理flushや電源断耐性が証明されたとは扱わない。

ReplaceFileWの1177でcurrent名が消失しても、明示退避ファイルと検証済みbak1/tempが残り、再起動はrecovery_requiredを返すこと。自動復元は禁止。1177分岐の自動試験はファイルportによるシミュレーションであり、OSが実際に1177を返した証拠ではない。

API参照: [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)、[MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)。`REPLACEFILE_WRITE_THROUGH`は非対応。`MOVEFILE_WRITE_THROUGH`も実機障害試験を省略する根拠にはしない。

## 証跡・合否記録

各ケースに、受入ID/停止工程、RUN_ID、コミット、ハーネスexe SHA-256、生成fixture SHA-256、実施者、独立レビュー者、日時、OS完全版、CPU/メモリ、NTFS/媒体、権限、故障条件、終了前後ログ、ファイル一覧/hash、inspect結果、明示復元結果を保存する。WebView2/アプリ版も全体受入記録へ記載する。

CFG-01/CFG-05の手動確認と独立レビューは未実施。`ACCEPTANCE_TEST_ASSIGNMENT.md`の担当割当と最終受入が終わるまで配布・リリース不可。
