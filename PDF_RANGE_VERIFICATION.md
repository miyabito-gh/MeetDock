# PDF Range 技術検証契約

更新日: 2026-09-19
設計判定: **承認済み**
技術検証: **未実施（実装後・リリース前ゲート）**

## 目的と上限

`material://pdf/{material_id}`から登録済みPDFだけを配信し、実パスをJavaScriptへ公開しない。通常経路はRange取得とし、全体取得を常用しない。

- `MAX_PDF_FALLBACK_BYTES = 33,554,432`（32 MiB）
- `MAX_RANGE_RESPONSE_BYTES = 8,388,608`（8 MiB）
- 32 MiBを超えるPDFでRangeが利用できない場合は`PDF_FALLBACK_TOO_LARGE`とし、外部アプリで開く導線を表示する。
- Range応答は要求先頭から最大8 MiBまでに短縮して`206`を返してよい。返した実範囲を`Content-Range`と`Content-Length`へ正確に記載する。

この上限は、WebView2とPDF.jsで同時に複数コピーが保持される場合のメモリ増加を抑えるための初期値である。設定画面には露出させない。

## URLと認可

- 許可する経路は`material://pdf/{material_id}`だけとする。
- `material_id`はURLデコードを1回だけ行い、`[A-Za-z0-9_-]{1,64}`へ完全一致させる。
- `/`、`\`、`.`のみのID、二重エンコード、query、fragment、余分なパス要素は拒否する。
- 要求ごとに現在の保存済み設定からIDを解決する。`target_type=file`、拡張子`.pdf`（大文字小文字を区別しない）、通常ファイル、読取可能であることを確認する。
- PDFヘッダーは先頭1024 byte以内の`%PDF-`で確認する。拡張子またはヘッダーが不一致なら内容を返さない。
- malformed ID、未登録ID、削除済みID、非PDFは存在有無を漏らさないため一律`404`とする。登録PDFの権限拒否は`403`、その他の読取失敗は`500`とし診断ログへ内部理由を残す。

## Range契約

GETとHEADだけを許可し、それ以外は`405`と`Allow: GET, HEAD`を返す。複数Rangeは初期版では扱わず`416`とする。

| 要求 | status | 必須ヘッダー/本文 |
|---|---|---|
| Rangeなし、totalが32 MiB以下 | `200` | `Content-Type: application/pdf`、`Accept-Ranges: bytes`、`Content-Length: total` |
| Rangeなし、totalが32 MiB超 | `413` | `Content-Length: 0`、アプリ側は`PDF_FALLBACK_TOO_LARGE`表示 |
| `bytes=start-end` | `206` | endをtotal-1と8 MiB上限で切詰め、正確な`Content-Range`と本文長 |
| `bytes=start-` | `206` | startからtotal-1または8 MiB上限まで |
| `bytes=-suffix` | `206` | 末尾suffix byte。suffixがtotal超なら全体、8 MiB上限を適用 |
| start>end、start>=total、suffix=0、複数Range、不正形式 | `416` | `Content-Range: bytes */total`、`Content-Length: 0` |
| HEAD | GETと同じstatus/headers | 本文なし |

すべての`200`、`206`、`416`へ`Accept-Ranges: bytes`を付ける。`206`の`Content-Length`は実際の本文長、`200`はtotal、`416`は0とする。整数計算は検証済み`u64`で行い、加算前に上限を確認する。0 byteファイルはPDFとして認可せず`404`とする。

## PDF.jsとCSP

- `pdfjs-dist`は現在のlockfileに固定された`5.4.149`を初期版の検証対象とする。
- Workerは同梱した`pdf.worker.min.mjs`をアプリの`/assets/pdfjs/`から読み込む。CDN、data URL、外部origin、実行時ダウンロードは使用しない。
- CSPの初期値は`default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' material:; img-src 'self' blob:; style-src 'self'`を基準とする。
- `unsafe-eval`と`unsafe-inline`は許可しない。ビルド後アセット名に合わせた最終CSPをWebView2実機で確認する。

現リポジトリの`src-tauri/tauri.conf.json`は`app.security.csp: null`であり、本契約をまだ満たしていない。PDF本実装時に承認済み候補を製品設定へ反映し、製品相当buildのWebView2実機試験で最終確定する。

## 暗号化・破損PDF

- 暗号化PDFはPDF.jsのpassword callbackで都度入力する。保存・ログ記録・自動再試行はしない。3回失敗または取消で当該プレビューを終了する。
- パスワード方式がPDF.js非対応なら`PDF_PASSWORD_REQUIRED`と「このPDFはアプリ内表示できません」を表示し、外部アプリで開く導線を出す。
- PDF.jsが構造エラーを返した場合は`PDF_CORRUPT`とし、他資料、同期、編集を継続可能にする。

## 実装後・リリース前技術検証

PDF本実装と自動試験の完了後、製品相当buildで次を確認する。次をすべて満たすまで配布・リリースしない。

1. Windows 11 x64とWebView2 Stableで、PDF.jsが`material://`へRange要求を送る。
2. 先頭、中間、末尾、open-ended、suffix、不正、複数Rangeが表どおりになる。
3. 128 MiB PDFの初回表示前に全体取得しないことをネットワークログで確認する。
4. Workerが同梱アセットから読み込まれ、CSP違反と`unsafe-eval`要求がない。
5. 線形化、非線形化、暗号化、破損PDFで規定の結果となる。
6. 高速切替時に旧Canvas描画が残らず、WorkerとDocumentが解放される。

## レビュー記録

- 2026-09-19: 403/404、Range構文、32 MiB全体取得上限、8 MiB応答上限、Worker/CSP方針を承認。
