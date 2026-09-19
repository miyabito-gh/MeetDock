# Windows API 検証計画

更新日: 2026-09-19
設計判定: **承認済み**
実機検証: **未実施（実装後・リリース前ゲート）**

## 初期版の対応範囲

- OS: Windows 11 x64（Microsoftがサポート中のビルド）
- WebView2: Stable Runtime。試験時の完全なバージョンを記録する。
- Office: Microsoft 365 Appsデスクトップ版 x64 Current ChannelのExcel/Word
- Office 32-bit、永続ライセンス版Office、PowerPointのROT特定、管理者権限で起動されたOfficeは動作保証外とし、タイトル照合または`unknown`へフォールバックする。
- MeetDock自体は一般ユーザー権限で動作し、自動昇格しない。

範囲外環境でもファイル起動はOS関連付けへ委譲できるが、起動状態の正確な検出と前面化を保証しない。

## Office ROT

- ROTによる`exact`判定はExcelとWordだけを対象とし、COM文書の`FullName`を正規化した絶対パスと登録パスが一致した場合に限る。
- パスは絶対化し、`/`を`\`へ統一し、`\\?\`接頭辞とルート以外の末尾区切りを除去したうえで、`CompareStringOrdinal(..., TRUE)`相当の大文字小文字を区別しない比較を行う。symlink・hard linkの同一性までは推測しない。
- COM初期化、列挙、個別プロパティ取得の失敗は他エントリの走査を止めず、全体結果を`unknown`へできるよう記録する。
- 同じパスに複数候補がある場合は、可視かつ有効な最初のHWNDを使用する。全候補が無効なら`WINDOW_NOT_FOUND`。
- 権限差によりROTが見えない場合、未起動と断定せず`unknown`とする。

## Restart Manager

Restart Managerは一般ファイルを使用しているプロセス候補の補助情報に限定し、個別文書の`exact`判定には使用しない。

- セッションはRAIIで包み、全経路で`RmEndSession`する。
- `ERROR_MORE_DATA`は最大3回、最大4096候補まで再取得する。超過は`unknown`とし無制限再試行しない。
- アクセス拒否、対象なし、API失敗を区別する。
- Restart Manager候補だけで前面化対象を決めない。タイトルとPID/実行ファイル情報が一意に一致した場合だけ`estimated`とする。

## タイトル照合

初期版では正規表現を実行しない。`window_match_pattern`は最大128文字のリテラルヒントとして扱う。

1. 可視なトップレベルウィンドウだけを列挙する。
2. NULを除去し、前後空白を削除し、連続するASCII空白を1個へ縮約する。
3. `CompareStringOrdinal(..., TRUE)`相当のロケール非依存・大文字小文字を区別しない比較で、ファイル名またはリテラルヒントの部分一致を確認する。
4. 同一PID・HWNDを重複排除する。
5. 候補が1件なら`estimated`、0件なら`not_detected`、2件以上なら誤前面化を避けて`unknown`とする。

アプリ名サフィックスの除去、曖昧な最短一致、正規表現、編集距離による推測は行わない。

## 前面化

- `IsWindow`を復元前と`SetForegroundWindow`直前に確認する。消失時は`WINDOW_NOT_FOUND`。
- 最小化中だけ`ShowWindow(SW_RESTORE)`を行う。
- `AttachThreadInput`はRAIIでdetachする。attach失敗は記録し、その後の前面化を1回だけ試す。
- `BringWindowToTop`または`SetForegroundWindow`が失敗、別デスクトップ、権限境界の場合は`FOREGROUND_DENIED`とする。
- 失敗時は可能なら`FlashWindowEx`を1回使用し、成功と偽装しない。連続ループ、キー入力偽装、強制デスクトップ切替は行わない。
- HWND消失、前面化拒否、API失敗を自由文ではなくIPCの固定エラーへ写像する。

## UNC検査

複雑な常駐ヘルパープロセスは初期版では採用せず、専用固定ワーカー方式に決定する。

- ワーカー数: 2
- キュー上限: 64件
- 同一正規化パスの重複要求: 1件へ統合
- UI待機上限: 600 ms。超過時は`timeout`を返し、UIをブロックしない。
- 成功・不存在キャッシュ: 30秒
- アクセス拒否・その他エラーキャッシュ: 10秒
- タイムアウトキャッシュと最短再試行間隔: 10秒
- キュー満杯: `PATH_QUEUE_BUSY`。ローカル資料の検査は継続する。
- 開始済みOS I/Oは強制停止できない前提とし、タイムアウト後に代替ワーカーを増殖させない。停止中ワーカーを含め常に最大2スレッドとする。
- 2ワーカーとも応答不能な場合は、そのセッション中の新規UNC要求を速やかに`timeout`または`queue_busy`とし、アプリ再起動案内を表示する。

この制限は、UNC障害時にもCPU・スレッド・メモリを有界に保つことを優先した判断である。

## 実機とモックの分離

| 対象 | Windows実機必須 | モック/単体 |
|---|---|---|
| Office ROT | M365 x64 Excel/Word、同名別パス、一般/管理者権限差 | 列挙失敗、重複候補、無効HWND |
| Restart Manager | API戻り値、実プロセス候補 | RAII、`ERROR_MORE_DATA`、4096上限 |
| タイトル照合 | Office/PDF/テキストの実タイトル | 正規化、リテラル、複数候補 |
| 前面化 | 最小化、拒否、別デスクトップ、消失 | API失敗分岐、RAII detach |
| UNC | SMB共有、ACL拒否、切断・遅延 | キュー、重複排除、TTL、飽和 |

## 実装後・リリース前実機検証

上表の実機必須項目をWindows 11 x64、M365 x64、WebView2 Stable、NTFS SSD、制御可能なSMB共有で実行する。OS、Office、WebView2、権限、端末仕様、ログ保存先を試験記録へ残す。結果が得られるまで配布・リリースしない。

## レビュー記録

- 2026-09-19: 対応環境、ROT範囲、リテラル照合、前面化制約、UNC 2ワーカー/64キュー/TTLを承認。
