# Phase 6 実装記録: PDF protocol / PDF.js

更新日: 2026-09-19

## 実装した範囲

- `material://pdf/{material_id}`をTauriの非同期custom protocolとして登録した。
- 要求ごとに`ConfigManager.resolve_materials`で保存済み設定を再読込し、main WebView・登録済みIDだけを解決する。
- URLは1回だけdecodeし、ID完全一致、query、余分なpath、二重encode、トラバーサルを拒否する。実パスはresponseへ出さない。
- `target_type=file`、`.pdf`、通常ファイル、非symlink、読取可能、先頭1024 byte以内の`%PDF-`を認可条件とした。
- GET/HEAD、単一Range 3形式、200/206/403/404/405/413/416と必須headerを実装した。
- Range読取はseek + 指定長だけに限定し、全体取得32 MiB、1応答8 MiBの上限を設けた。
- PDF.js 5.4.149のWorkerを`public/assets/pdfjs/pdf.worker.min.mjs`へ同梱し、固定ローカルURLだけを指定した。
- CSPを承認済み候補へ変更し、CDN、`unsafe-eval`、`unsafe-inline`、data URLを含めていない。
- `PdfViewAdapter`にcancel、generation更新、Canvas初期化、cleanup、destroy、新規loadの順序を実装した。
- passwordは注入された都度入力portだけから受け、3回失敗または取消で当該loadを終了する。保存・ログ・自動再試行は行わない。
- 古いload/render/password callbackはgenerationで破棄し、PDF失敗をMediatorの既存PDF状態以外へ波及させない。

## 自動試験

- Rust 43 tests: 合格（protocol 4、既存39）
- JavaScript 489 tests: 合格（PDF adapter 4、Worker/CSP 1、既存484）
- Vite production build: 合格。PDF.js本体をbundleし、Workerを`dist/assets/pdfjs/`へコピーする。
- `cargo check`: 合格
- `git diff --check`: 合格

protocol試験ではGET/HEAD、closed/open-ended/suffix Range、不正・複数Range、8 MiB短縮、32 MiB超413、405、認可失敗、403/404、headerと本文長を確認した。adapter試験では高速切替時の破棄順、古いloadの破棄、password上限、URL/ID bindingを確認した。

## 未検証・リリースゲート

以下は自動試験だけで合格扱いにしない。

- PDF-01: Windows 11/WebView2 Stableで128 MiB PDFが全体取得前にRange表示されること
- PDF-02: 実WebView2で10 PDF高速切替時に最後だけが表示され、旧Canvas・未処理rejectionがないこと
- PDF-04: AES暗号化PDFの正誤password、3回失敗、取消、非保存
- PDF-05: truncate/xref破損PDFの`PDF_CORRUPT`と他操作継続
- production CSPでWorker・`material://`通信に違反がないこと
- 線形化/非線形化PDFとWebView2固有のcustom protocol URL変換

Phase 6の実装と自動試験は完了したが、上記実機受入が残るためPDF機能全体およびリリース判定は未完了である。
