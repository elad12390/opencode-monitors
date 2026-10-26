# OpenCode Sentinel

opencode 用の Monitor プラグイン。バックグラウンドプロセスの stdout をリアルタイムでエージェントに通知します。

## 機能

- **プロセス監視**: 任意のシェルコマンドをバックグラウンドで実行し、stdout の各行をエージェントに steer 通知
- **並行監視**: 複数の monitor を同時起動可能
- **200ms バッチ**: 高頻度の出力を 200ms 間隔でまとめて通知（レート制限）
- **フラッド対策**: 100 行/秒を超えると自動停止
- **stderr 分離**: stderr は `/tmp/sentinel-{id}-stderr.log` に記録
- **クリーンアップ**: セッション終了・プラグインアンロード時に全プロセスを自動停止

## 対応バージョン

opencode-sentinel は単一パッケージで OpenCode **V1** と **V2** の両方をサポートします（デュアルエントリポイント）。

| OpenCode | プラグインのエントリポイント | 状態 |
|---|---|---|
| V1 `>=1.18.29` | オブジェクト形式: `server(input)` | 対応 |
| V2 `2.0.x` | オブジェクト形式: `setup(ctx)` | 対応 |

デフォルトエクスポートが `setup`（V2）と `server`（V1）の両方を提供します。V1 環境では V1 実装を遅延 import するため V2 専用パッケージは不要です。V2 環境では V1 パッケージ（`@opencode-ai/plugin` / `@opencode-ai/sdk`）も `zod` も不要です。

> **注意:** OpenCode V1 の `1.18.29` 未満は**関数**形式のデフォルトエクスポートを要求するため、0.2.0 ではサポートしません。該当バージョンを使っている場合は 0.1.x のままにするか、OpenCode をアップグレードしてください。

## インストール

```json
// opencode.json に追加
{
  "plugin": ["opencode-sentinel"]
}
```

またはファイルパス指定:

```json
{
  "plugin": ["file:///path/to/opencode-sentinel/src/index.ts"]
}
```

## 使い方

### ログ監視

```
monitor で /var/log/app.log の ERROR 行を監視して
```

エージェントが以下のツールを呼び出します：
- `monitor` — 監視開始（コマンド + 説明ラベル）
- `stop_monitor` — 指定した monitor を停止
- `list_monitors` — 実行中の monitor 一覧

### grep を使う場合の注意

パイプで grep を使う場合は **必ず `--line-buffered` を指定**してください。

```
✅ tail -f /var/log/app.log | grep --line-buffered ERROR
❌ tail -f /var/log/app.log | grep ERROR
```

### 出力のフィルタリング (filter)

JavaScript の正規表現を `filter` に渡すと、マッチした行だけ通知します:

```
monitor with:
  command: tail -f /var/log/app.log | grep --line-buffered -E "(ERROR|WARN)"
  filter: "ERROR"
```

ERROR 行だけが通知され、WARN 行は通知されません。

### ワンショット待機 (until)

`until` を使うと、マッチした行が現れた時点で monitor を自動終了します。
「CI が終わったら起こして」のような sleep ポーリング不要のパターンに最適:

```
monitor with:
  command: gh run watch <run-id>
  until: "(completed|failed)"
```

`until` がマッチすると該当行が通知され、monitor は自動的に終了します。
`filter` と組み合わせて、まずストリームを絞ってから `until` を評価することもできます:

```
monitor with:
  command: tail -f build.log
  filter: "(error|fatal)"
  until: "BUILD (SUCCESS|FAILED)"
```

## 制限事項

- **プロセスの孤児化**: opencode 本体が `SIGKILL` などで強制終了した場合、監視プロセスが残る可能性があります。通常の終了（`dispose` フック経由）では全プロセスが停止されます。
- **即時割り込み不可**: エージェントが LLM 応答のストリーミング中は、その turn が終わるまで steer 通知は取り込まれません。アイドル時は 500ms 以内に反応します。

## steer と queue の違い

sentinel は `delivery: "steer"` を使用してエージェントに通知を送ります。これは opencode の `delivery` パラメータの2つのモードと以下のように異なります：

| モード | 挙動 |
|--------|------|
| **steer**（sentinel が使用） | アイドル時は即座にエージェントを wake して新規 run を開始。実行中は現在の provider turn が終了した後、次の turn の冒頭で取り込まれる。ストリーミング中は割り込み不可。 |
| **queue** | run が完了するまでキューに溜められ、次のユーザー入力時にまとめて取り込まれる。リアルタイム性が必要な監視には不向き。 |

steer を選択している理由：
- **リアルタイム性**: アイドル時の即時 wake により、ログ監視の即応性を確保
- **割り込み抑制**: 実行中の LLM 応答は妨げず、turn の切れ目で自然に取り込まれる
- **キュー詰まり防止**: queue だと長時間 run 中に通知が滞留するのを回避

## 技術スタック

- TypeScript (strict)
- OpenCode V2 プラグイン API（`setup(ctx)`）と V1 Hooks API（`server`）
- @opencode-ai/plugin / @opencode-ai/sdk/v2（V1 経路のみ）
- Bun / Node.js 互換
