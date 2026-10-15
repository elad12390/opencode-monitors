# ADR 0002: V1/V2 デュアルエントリポイントで OpenCode 1.x と 2.x を両対応する

## Status

Accepted（2026-10-16）

## Context

`opencode-sentinel` は当初 OpenCode V1 の Hooks API 向けに、`export default async (input) => ({ tool, event, dispose })` という関数エントリポイントで実装されていた。

OpenCode V2（2.0.x）でプラグイン API が刷新された。V2 はオブジェクト形式のエントリポイント（`export default { id, setup(ctx) }`）を要求し、ツール登録（`ctx.tool.transform`）・セッション配信（`ctx.session.prompt`）・イベント購読（`ctx.event.subscribe`）を `setup(ctx)` のコンテキスト経由で行う。一方 V1 も `1.18.29` 以降はオブジェクト形式の `server` エントリポイントを受け付ける。

実測により、以下のホスト差異が判明した：

- **V2（2.0.29）**: `setup(ctx)` のみを呼ぶ。`ctx` は `tool`/`session`/`event`/`storage` を含む完全なコンテキスト。V1 パッケージ（`@opencode-ai/plugin` / `@opencode-ai/sdk` / `zod`）は**解決できない**。
- **V1（1.18.34）**: `server(input)` を呼ぶ。加えて V2-preview ランタイムから `setup(ctx)` も呼ばれるが、その `ctx` は `tool`/`session`/`event` を欠く部分コンテキストである。

### 解決したい課題

単一の配布パッケージで OpenCode V1 と V2 の両方を動作させたい。かつ、V2 ホストが V1 専用パッケージを解決できないという制約を、既存 V1 ユーザーを壊さずに吸収したい。

### 検討した選択肢

| | アプローチ | 概要 |
|---|---|---|
| **A** | V2 のみ対応 | V1 サポートを打ち切り、V2 API に一本化 |
| **B** | V1 のみ維持 | V2 対応は保留し、V1 API のまま据え置き |
| **C** | デュアルエントリポイント | 単一パッケージで `setup`（V2）と `server`（V1）を併存 |
| **D** | パッケージ分離 | `opencode-sentinel-v2` を別パッケージとして公開 |

### 各選択肢の評価

| 観点 | A: V2 のみ | B: V1 のみ | C: デュアル | D: 分離 |
|---|---|---|---|---|
| 既存 V1 ユーザー | ×（破壊的） | ★★★ | ★★★（影響なし） | ★★（移行が必要） |
| V2 対応 | ★★★ | ×（不可） | ★★★ | ★★★ |
| 保守コスト | ★★★（単一経路） | ★★★ | ★★（2 経路） | ★（二重管理） |
| リリース運用 | ★★★ | ★★★ | ★★★ | ★（2 パッケージ同期） |
| 実装リスク | ★★（V1 破壊） | ★★★ | ★★（エントリ判別・遅延 import） | ★★（利用者の混乱） |

## Decision

**単一パッケージのデュアルエントリポイント（案 C）を採用する。** デフォルトエクスポートで `id`・`setup`（V2）・`server`（V1）を提供する。

```ts
export default {
  id: "opencode-sentinel",
  setup: v2Setup,           // V2: オブジェクト形式
  async server(input) {     // V1: 関数形式。V1 実装を遅延 import
    const { v1Server } = await import("./v1")
    return v1Server(input)
  },
}
```

### 1. 選定理由

- **既存 V1 ユーザーを壊さない**：`server` 経路は従来どおりの Hooks API を維持する。
- **単一コードベース**：監視コア（`src/lib/core.ts`、`watcher`、`manager`）を両経路で共有し、二重管理を避ける。ホスト固有の配信のみを `deliver` 関数として注入する。
- **V1 パッケージ非依存の V2 経路**：V2 ホストが V1 パッケージを解決できない問題は、`server()` 実行時の**遅延 dynamic import** で回避する。これにより V2 経路（`index.ts` → `v2.ts` → `lib/core`・`lib/watcher`・`monitor.txt`）は外部 npm 依存ゼロになる。

### 2. V1 環境での安全策

OpenCode `1.18.x` は V2-preview ランタイムからも `setup(ctx)` を呼ぶ。この部分コンテキストで `ctx.tool.transform` を呼ぶと失敗するため、`setup` の先頭で能力検出し、欠落時は即 `return`（no-op）して V1 経路に委ねる：

```ts
if (typeof ctx?.tool?.transform !== "function" || typeof ctx?.session?.prompt !== "function") return
```

### 3. 検証方針

- 型・単体：`bunx tsc --noEmit` と `bun test`
- V1 実機：opencode 1.18.34 で `server(input)` 呼び出しを確認
- V2 実機：`opencode2`（2.0.29、別バイナリ）で E2E。ツール登録・steer 配信・`list`/`stop` を確認

## Consequences

### Positive

- V1/V2 の両環境を単一パッケージでカバーできる
- 監視コアを共有するため、機能追加（filter/until 等）は両環境に自動反映される
- 将来 V1 サポートを終了する際は `server` と `src/v1.ts` を外すだけでよい

### Negative

- エントリポイントが 2 経路になり、ホスト差異（コンテキスト形状・配信 API）を吸収するコードが増える
  - → 差異はアダプタ（`v1.ts` / `v2.ts`）に閉じ込め、コアはホスト非依存に保つ
- `setup` の能力検出ガードという暗黙の前提が生じる
  - → 本 ADR とコードコメントに明記し、実機 E2E で担保する

### Risks

- **V2 API のドリフト**：V2 のプラグイン API が変更されると `v2.ts` が追随を要する
  - → `opencode2` による実機 E2E を追加のたびに実行して検知する
- **V1-preview の挙動変化**：1.18.x の V2-preview が部分コンテキストで `setup` を呼ぶ前提が崩れる可能性
  - → 能力検出は「機能があれば使う」方式のため、コンテキストが増えても安全側に倒れる

## 決めていないこと

| 項目 | 決めない理由 | いつ決めるか |
|---|---|---|
| `sentinel_spike` の V2 移植 | V1 専用の開発ツールであり V2 では不要 | V2 で必要になった時 |
| V1 サポート終了時期 | 利用状況と OpenCode 本体の V2 移行状況に依存 | V2 が主流化した時 |
| V2 固有機能（TUI/RPC 連携等）の追加 | 本 ADR は互換対応に限定 | 別 Issue で判断 |

## Notes

### 参考資料

- OpenCode V2 プラグイン API（`setup(ctx)` / `ctx.tool.transform` / `ctx.session.prompt`）
- `@opencode/plugin` 2.0.29 の型定義（参考。実装は V2 経路を外部依存ゼロに保つため、`src/v2.ts` 内でコンテキストを構造的に定義しており、この型には依存しない）
- 実測 spike（opencode 1.18.34 / opencode2 2.0.29）
- 関連 Issue: opencode-sentinel #20
