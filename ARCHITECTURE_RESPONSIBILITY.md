# アーキテクチャ責務図

更新日: 2026-09-19
判定: **設計承認済み**

## 設計原則

- 初期版は単一ウィンドウ、単一プロセス、単一Mediatorとする。
- 業務状態はMediatorだけが変更する。View、Presenter、Application Serviceは状態を直接変更しない。
- Windows API、ファイルI/O、Tauri IPC、タイマーはEffect Runner経由でApplication Serviceへ委譲する。
- 階層Presenter間の転送チェーンは作らない。固定された短いイベント経路だけを使用する。
- 画面の見栄えだけに関する処理はView内で完結できるが、保存、起動、同期、PDF対象変更は必ずMediatorへ送る。

## Root起点の確定構成

```text
Root (Composition Root / lifecycle)
├─ Event Dispatcher
│  └─ RootLifecycleHandler → MediatorHandler → DiagnosticFallbackの固定CoR
├─ Mediator / State Machine
│  ├─ AppStateを一元管理
│  ├─ ガード評価と状態遷移
│  ├─ RenderModel生成
│  └─ Effectを宣言（実行はしない）
├─ Effect Runner
│  └─ EffectをApplication Serviceへ1回だけ委譲し、結果をUiEventとして戻す
├─ Presenter群
│  └─ View入力とUiEvent、RenderModelとViewパラメータを相互変換
├─ Passive View群
│  └─ DOM描画、入力、選択、フォーカス、アクセシビリティ
└─ Application Service群
   ├─ SettingsService → ConfigManager
   ├─ MaterialStatusService → FileChecker / WindowManager
   ├─ LaunchService → Launcher / WindowManager
   └─ PdfService → MaterialProtocol
```

Rootは依存を組み立てるだけで、個別資料の起動可否、保存可否、PDF認可を判断しない。MediatorはOS APIやI/Oを呼ばず、`Effect`を返す。Effect Runnerは状態を解釈せず、指定されたServiceを呼び、その結果をイベントへ変換する。

## 責務表

| 層 | 担務 | 禁止事項 |
|---|---|---|
| Root | 依存の組立、起動・終了、イベント入口 | 個別Viewの業務判断、Win32/I/O実行 |
| View | DOM描画、入力通知、選択・フォーカス・ARIA | IPC、永続化、Win32、業務状態遷移 |
| Presenter | Viewとの変換、表示パラメータ設定、入力の型付け | Presenter間通信、保存・起動可否の判断 |
| Event Dispatcher | 固定CoRを順に1回実行し、Handledで停止 | 状態変更、副作用実行、イベント再送、動的handler登録 |
| Mediator | 状態、ガード、遷移、Effect発行 | Win32、ファイルI/O、Tauri invokeの直接実行 |
| Effect Runner | Effectの一度だけ実行、結果イベント化 | UI状態の判断、独自の再試行 |
| Application Service | ユースケース実行、DTO境界、キャンセル可能範囲の管理 | DOM操作、UI状態の直接変更 |
| Infrastructure | 設定、PDF、Windows、UNCの具体処理 | UI仕様・表示文言の判断 |

## イベントチェーン

イベント経路は次の固定5段とする。Chain of Responsibilityは`RootLifecycleHandler → MediatorHandler → DiagnosticFallback`の3 handlerに固定し、動的登録や親Presenter探索は採用しない。

1. Viewが生の入力を所有Presenterへ通知する。
2. Presenterが入力を型付けされた`UiEvent`へ変換する。
3. Event Dispatcherが固定CoRを先頭から実行する。RootLifecycleHandlerはウィンドウ終了などRoot固有イベントだけを処理し、その他をMediatorHandlerへ渡す。
4. 最初に`Handled { state, effects[] }`を返したhandlerで停止する。どちらも処理しなければDiagnosticFallbackが副作用なしでログを残す。
5. `Handled`なら描画後にEffect Runnerが`effects`を列挙順に各1回実行する。

Serviceの成功・失敗も新しい`UiEvent`として同じ経路へ戻す。イベントをPresenter同士で転送しない。再入を避けるため、1イベントの遷移と描画が終わるまで次イベントはFIFOキューで待機させる。キュー上限はUIイベント256件とし、連続する検索文字入力とリサイズは最新値へ統合する。

## Passive Viewの範囲

Viewが扱えるのはDOM更新、ボタン活性、選択、入力値、フォーカス、スクロール、ARIA属性、Canvasへの描画だけである。URL許可判定、パス解決、revision判定、PDF認可、Win32呼出しは扱わない。

PDF.jsの技術的な`renderTask.cancel()`、Canvas初期化、`cleanup()`、`destroy()`は`PdfViewAdapter`が担当してよい。ただし、表示対象ID、表示世代、再試行可否はPresenter/Mediatorから受け取り、Adapter自身で業務状態を決めない。ネイティブDnDは`DndAdapter`が入力を正規化候補へ変換し、保存前の採否はMediatorが決める。デバウンスや遅延実行はEffect RunnerのSchedulerが所有する。

## 複雑化・負荷の上限

- グローバル状態管理ライブラリ、動的DIコンテナ、汎用イベントバスは導入しない。
- 通常の操作でイベント経路を5段より増やさない。
- RenderModelは変更対象の領域だけ更新し、全資料のDOM再構築を避ける。
- 検索、リサイズ、自動同期は重複要求を統合し、バックグラウンド処理のキューを有界にする。
- 将来機能のための抽象化は追加せず、既存の2実装以上で必要になった時点で導入する。

## レビュー記録

- 2026-09-19: プロジェクトオーナー指示に基づき、単純性、操作性、負荷抑制を優先して承認。
