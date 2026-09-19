# 受入試験割当表

更新日: 2026-09-19
設計判定: **方法・担当ロール承認済み**
実施状況: **未実施**

## 担当ルール

- 自動試験の作成・一次実施: 本実装担当
- Windows/PDF実機試験の一次実施: Windows統合担当（本実装担当が兼務可）
- 合否レビュー: 設計レビュー担当
- 最終受入: プロジェクトオーナー

個人名を固定して引継ぎを難しくせず、作業割当時に各ロールの実名、実施日、証跡リンクを試験記録へ追記する。作成者と合否レビュー担当は同一人物にしない。

## 試験環境

- Windows 11 x64のサポート中ビルド、一般ユーザー権限
- Microsoft 365 Apps x64 Current Channel（Excel、Word）
- WebView2 Stable Runtime（完全な版番号を実施時に記録）
- NTFS SSDと、接続・切断・ACL拒否を制御できるSMB共有
- 配布相当のrelease build。障害注入だけは専用test buildを許可する。
- ログ、画面記録、fixture hash、OS/Office/WebView2/アプリ版を試験記録へ保存する。

### 現在の作業端末の確認結果

- x64、DisplayVersion 25H2、build 26200.9457
- WebView2 Runtime 153.0.4234.46
- Microsoft 365/Excel/WordはClick-to-Run登録および標準配置で未検出
- 制御可能なSMB試験先は未登録

したがって、この端末はWebView2試験候補にはできるが、WIN-01/02のOffice ROT試験とPATH-04/05のUNC試験を単独では完了できない。OS製品名、端末仕様、WebView2版は実施時に正式な試験記録として再取得する。

## ケース別割当

| ID | 方法 | 環境/fixture | 一次担当 | 合格条件 |
|---|---|---|---|---|
| CFG-01 | Rust統合＋プロセス強制終了 | NTFS、保存工程ごとの障害注入 | 本実装担当 | 現行または最高revisionの検証済み候補を提示し、無断復元しない |
| CFG-02 | Rust統合 | 同revisionから2保存 | 本実装担当 | 後着を`CONFIG_CONFLICT`、先行データを保持 |
| CFG-03 | Rust単体 | 自己参照・2/100階層循環 | 本実装担当 | 全件`VALIDATION_ERROR`、ファイル無変更 |
| CFG-04 | Rust統合 | schema 4＋未知フィールド | 本実装担当 | `read_only_future_schema`、config無変更、保存/起動不可 |
| CFG-05 | Rust統合＋手動確認 | 破損current、正常/破損bak混在 | 本実装担当 | 検証済み候補だけを表示し、選択後に復元 |
| WIN-01 | Windows実機 | M365 Excel/Word x64 | Windows統合担当 | 絶対パス一致だけを`exact`、前面化結果を正しく表示 |
| WIN-02 | Windows実機 | 同名・別フォルダの2文書 | Windows統合担当 | ROT対象は誤認せず区別 |
| WIN-03 | Windows実機＋APIモック | 前面化拒否・別デスクトップ | Windows統合担当 | `FOREGROUND_DENIED`、成功表示なし、可能なら1回点滅 |
| WIN-04 | 単体＋実機 | `[]().*`を含むファイル名 | 本実装担当 | 正規表現評価せずリテラル照合、複数候補は`unknown` |
| WIN-05 | Rust単体＋実機 | https/http/javascript/data URL | 本実装担当 | httpsのみ起動、他は`VALIDATION_ERROR` |
| WIN-06 | 統合 | 3件中2件目失敗 | 本実装担当 | 1・3件目を継続、資料別結果と件数が一致 |
| PATH-01 | Rust単体 | 存在するローカルファイル/フォルダ | 本実装担当 | `exists` |
| PATH-02 | Rust単体 | 不存在ローカルパス | 本実装担当 | `missing` |
| PATH-03 | Rust単体＋Windows実機 | ACL拒否パス | Windows統合担当 | `access_denied`、missingと混同しない |
| PATH-04 | Windows実機 | 応答停止SMBを20件 | Windows統合担当 | 600 ms以内に暫定timeout、ワーカー2・キュー64を超えない |
| PATH-05 | Rust統合＋Windows実機 | 同一UNCを連続100要求 | Windows統合担当 | 1要求へ統合、timeout後10秒以内に再投入しない |
| PDF-01 | protocol統合＋WebView2実機 | 128 MiB PDF | Windows統合担当 | 初回前に全体取得せずRange、メモリ/通信記録を保存 |
| PDF-02 | JS自動＋WebView2実機 | 10 PDFを200 ms間隔で切替 | 本実装担当 | 最後のPDFだけ表示、未処理例外・旧Canvasなし |
| PDF-03 | protocol統合 | 境界・open-ended・suffix・複数/不正Range | 本実装担当 | 契約どおり206/416、長さ完全一致、停止なし |
| PDF-04 | WebView2実機 | AES暗号化PDF、正/誤password | Windows統合担当 | 都度入力、3回失敗/取消で終了、password非保存 |
| PDF-05 | WebView2実機 | truncate・xref破損PDF | Windows統合担当 | `PDF_CORRUPT`、他操作継続 |
| SEC-01 | JS DOM単体＋実機 | HTML/SVGイベント属性文字列 | 本実装担当 | textとして表示、スクリプト実行なし |
| SEC-02 | Rust単体 | 禁止URL schemeと制御文字 | 本実装担当 | 保存時`VALIDATION_ERROR` |
| SEC-03 | protocol統合 | malformed/未知/非PDF ID | 本実装担当 | 一律404、実パス・存在有無を本文/ログへ露出しない |
| UI-01 | JS自動＋手動 | 2,000資料検索 | 本実装担当 | 100 ms目標、所属グループ表示、選択文脈維持 |
| UI-02 | JS自動＋手動 | conflict/IO失敗注入 | 本実装担当 | 入力保持、未保存表示、再読込/再試行導線 |
| UI-03 | WebView2手動 | キーボードのみ、200%表示 | 設計レビュー担当 | 主要操作へ到達、フォーカス可視、フォーカストラップなし |

## 設計試験

| 対象 | 方法 | 一次担当 | 合格条件 |
|---|---|---|---|
| Mediator遷移 | JS純粋関数の表駆動試験 | 本実装担当 | 状態表の全行、全ガード失敗、副作用0/1回を網羅 |
| Event Chain | Dispatcher/Presenter単体 | 本実装担当 | 各イベントがMediatorへ最大1回、Unhandledは副作用0回 |
| Rust/JS契約 | 共通fixture JSONを双方で検証 | 本実装担当 | enum、null、未知フィールド、未知schema、AppErrorが一致 |
| 永続化障害 | Rust統合・工程別障害注入 | 本実装担当 | 全クラッシュ地点で現行または候補が少なくとも1つ残る |

## 代表データ

個人情報を含まない生成fixtureを使用し、生成スクリプトのseedとSHA-256を記録する。

- 100グループ、500資料の通常設定
- 2,000資料の検索設定
- ローカル200件、UNC timeout 20件の同期設定
- PDF: 1 MiB線形化、20 MiB非線形化、128 MiB大容量、AES暗号化、truncate破損、xref破損
- Office: 同名・別フォルダのExcel/Word、タイトルに正規表現記号を含む文書
- URL: https、http、javascript、data、file、制御文字入り

## 完了条件

各ケースに実施者、レビュー者、日時、環境、結果、証跡を記録し、全必須ケースが合格すること。不合格を既知制約として受け入れる場合は、プロジェクトオーナーの明示承認と利用者向け制約記載を必須とする。

## レビュー記録

- 2026-09-19: 試験方法、担当ロール、基準環境、代表データ、ケース別合格条件を承認。
