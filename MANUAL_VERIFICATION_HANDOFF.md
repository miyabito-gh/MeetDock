# MeetDock 手動確認 引継ぎ

更新: 2026-09-19。Phase 0〜3実装完了後の手動確認準備。
開始時のローカルmasterは`a78a68b`、作業ツリーclean、origin/masterより7コミット先。
今回のユーザー指示で、run.ps1と本書を追加し、既存の未pushコミットを含めorigin/masterへpushする。配布・リリースの承認ではない。

## 最初に実行すること

WindowsのPowerShellでリポジトリへ移動し、まずdev起動を確認する。

```powershell
Set-Location C:\Users\wmasa\Documents\Rust\MeetDock
git status --short --branch
git log -4 --oneline
.\run.ps1 dev
```

MeetDockウィンドウで「バックエンド接続確認」を押し、`MeetDock backend is ready`が表示されることを確認。終了時はウィンドウを閉じ、必要なら起動元ターミナルでCtrl+Cを押してdevプロセスも終了する。

次にローカル確認用exeをbuildする。

```powershell
.\run.ps1 build
& .\src-tauri\target\release\meetdock.exe
```

同じ接続確認を行う。dev版を終了してからexeを起動する（二重起動時は既存ウィンドウへ通知される）。`CARGO_TARGET_DIR`を設定している環境ではexe出力先もその設定に従う。

run.ps1の仕様:

- 引数は`dev`/`build`、省略時はdev。`-Mode build`形式も使用可能。
- 呼出元の作業ディレクトリに関係なくリポジトリ直下で実行し、終了時に元の場所へ戻す。
- devは`npm run tauri -- dev`（ViteとRust/Tauriを起動）。
- buildは`npm run tauri -- build --no-bundle`（最適化exeまで。インストーラー/配布bundleは生成しない）。exeは自動起動しない。
- Node.js 22以上、npm、Rust/cargo、既存Node依存を確認。実行失敗は非0終了コードで返す。
- 依存の自動インストール、設定ファイルの初期化/削除、git操作はしない。

初回セットアップでnode_modulesがない場合は先に`npm ci`。Rust MSVC、Visual Studio C++ Build Tools/Windows SDK、WebView2 Runtimeも必要。PowerShell実行ポリシーで拒否される場合は、内容を確認し組織ポリシーに従ったうえで`powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 dev`をその起動だけに使用できる。恒久的な実行ポリシー変更は不要。

## 今確認できる範囲

画面はまだ疎通確認用。設定編集・保存・復旧の本番UIには接続していないため、dev/buildで画面が開くだけでPhase 3受入が完了したとは扱わない。

設定永続化は試験専用ハーネスで確認する。既存のAPPDATA設定を使った破壊的試験は行わない。

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --example cfg01
& .\src-tauri\target\debug\examples\cfg01.exe seed
$cfg01Run = 'seedが表示した32桁RUN_ID'
& .\src-tauri\target\debug\examples\cfg01.exe save $cfg01Run
& .\src-tauri\target\debug\examples\cfg01.exe inspect $cfg01Run
```

通常保存はrevision13、再読込はready/13。各障害ケースでは新規seedし、[CFG-01実機手順](CFG_01_VERIFICATION.md)に従う。プロセス終了、ACL、共有違反の対象は専用fixture/ハーネスだけ。ハーネスは任意の設定パスを引数に取らない。

## 実装・試験の基準

- Phase 0〜2: `beaaad9` / `105b57d`。DTO、strict IPC契約、純粋Mediator、固定Event Chain。
- Phase 3: `388eb6e` / `1efe68a` / `a78a68b`。完全な業務検証、Mutex/revision、temp/sync/再検証、backup、Windows置換API、明示復旧・設定IPC。
- 詳細: [Phase 0〜2記録](PHASE_0_2_IMPLEMENTATION.md)、[Phase 3記録](PHASE_3_IMPLEMENTATION.md)。正本順位は[実装引継ぎ](IMPLEMENTATION_HANDOFF.md)を参照。
- 前回の自動試験: npm test 484成功、Rust 30試験成功（共有fixture392件を含む）、npm run build/cargo check/fmt/diff check成功。
- 今回の準備確認: PowerShell構文解析成功、`run.ps1 build`成功（Tauri release profile、`src-tauri/target/release/meetdock.exe`生成、終了コード0）、`git diff --check`成功。devはインストール済みTauri CLIの対応引数を確認した。dev/exeの起動・画面操作確認は利用者が実施する。
- build初回は既知のesbuild親ディレクトリ参照のsandbox拒否で終了コード1。同じスクリプトを承認された権限で再実行し成功。コード不良として回避変更はしていない。通常の手動実行で管理者権限を要求するスクリプトではない。
- 今回のpushはソース共有のため。過去文書の「pushなし」は各実装終了時点の記録であり、今回の明示指示で変更された。

## 確認結果の引継ぎ

実施コミット、日時、実施者、OS/WebView2版、起動方法（dev/build/harness）、操作、期待値、結果、ログ/画面記録を残す。不具合には再現手順と表示エラーを添える。ユーザーの既存変更は保持し、reset/checkoutによる破棄や履歴巻戻しはしない。

未実施: CFG-01実機障害注入、CFG-05の製品UI手動復元、独立レビュー、PDF/WebView2、Windows起動/前面化、UNC/SMBの実機試験。CONDITIONAL PASSを維持し、全必須試験と受入・承認が完了するまで配布・リリースしない。

次の実装担当は手動確認の結果を先に確認し、必要な修正を行ってからPhase 4へ進む。今回の準備ではPhase 4以降の機能を追加しない。
