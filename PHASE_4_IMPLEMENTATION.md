# Phase 4 状態同期・パス検査 実装記録

更新日: 2026-09-19

## 実装結果

- `sync_material_statuses` をstrictな `{ request }` IPCとして登録した。
- フロントエンドから実パスを受けず、`material_id`を現在の保存済み設定から解決する。
- ローカルパスは通常のmetadata検査、UNCは専用固定2スレッドへ分離した。
- UNCキューは待機64件を上限とし、正規化した同一パスの処理と待機者を統合する。
- UI待機期限を600 msとし、開始済みI/Oを中断したり代替ワーカーを増やしたりしない。
- exists/missingは30秒、access_denied/error/timeoutは10秒キャッシュする。
- timeout後の10秒キャッシュにより即時再投入を防止する。
- キュー満杯は対象資料を`unchecked`、`detail: PATH_QUEUE_BUSY`として返し、同一バッチのローカル検査を継続する。
- UI期限超過は対象資料を`timeout`、`detail: PATH_TIMEOUT`として返す。
- URLはパス検査対象外として`unchecked`を返す。Phase 5までopen stateは`unknown`とする。
- 応答の`request_id`は要求値をそのまま返す。既存Mediator、Effect Runner、IPC adapterが不一致・古い応答を破棄する。

## 自動試験

- PATH-01: 存在するローカルパスを`exists`へ分類
- PATH-02: 不存在ローカルパスを`missing`へ分類
- PATH-03境界: probeの`PermissionDenied`を`access_denied`へ分類する実装
- 同一UNCの大小文字・区切り差を1回のprobeへ統合
- UNC結果のキャッシュ利用
- 600 ms以内のtimeout応答とtimeoutキャッシュ
- 64件満杯時の`PATH_QUEUE_BUSY`
- 通常UNC、extended UNC、extended local、device namespaceのルーティング境界
- 固定値（2 worker、64 queue、600 ms、30/10秒TTL）

## 未完了の実機検証

- ACL拒否パスでのPATH-03 Windows実機確認
- 制御可能な停止SMB 20件でのPATH-04（600 ms、2 worker、64 queue）
- 同一UNC 100連続要求でのPATH-05（重複排除、timeout後10秒再投入禁止）

これらは試験環境未登録のため合格扱いにしない。`ACCEPTANCE_TEST_ASSIGNMENT.md`に従いPhase 8で証跡を保存する。
