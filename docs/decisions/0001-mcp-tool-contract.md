# ADR 0001: Tool Plugin Contract を MCP に構造的に一致させる

- 状態: 提案
- 日付: 2026-08
- 関連: [Tool Plugin Contract](../contracts/tool-plugin.md) / [設計レビュー](../architecture/core-plugin-review.md)

## 文脈

Tool Calling 機能を Plugin として追加できる構造へ移行するにあたり、Core と Plugin の接点となる契約を定める必要がある。

要件として「実装にあたり独自の規格になることを避けたい。Ollama や OpenAI、Claude などが対応しているツールなら、ほぼ手を加えることなく Plugin にできる契約にしたい」が挙げられている。導入容易性だけでなくメンテナンス性の向上も見込んでいる。

設計素案は独自の `ToolPlugin` / `PluginManifest` / `Tool` 型と、独自の permission 文字列 (`memory.read`, `network.http` 等) を提案していた。

現状 (`dev`) の `ToolConfig` は以下の形で、既に2つの tool 群 (`long-term-memory`, `web-search`) を `mergeToolConfigs` で合成している。

```ts
interface ToolConfig {
  definitions: ToolDefinition[];   // { name, description, parameters }
  onCall: (name, argsJson, signal?) => Promise<string>;
  instructions?: string[];
}
```

## 決定

**Core Contract の型を MCP (Model Context Protocol) `2026-07-28` と構造的に一致させる。** 加えて、外部 MCP サーバを同じ Registry にマウントできる二層構成を採る。

- Tier 1 (in-process): 自作 Plugin は MCP 型に一致した素の TS オブジェクト。JSON-RPC を通さない
- Tier 2 (外部 MCP): `@modelcontextprotocol/sdk` のクライアントで既製サーバを接続し、`tools/list` の結果を同じ Registry へ流す

MCP に無い概念 (ツール群の指示文、レイテンシ級) だけを MCP 予約の `_meta` に名前空間キーで足す。

## 理由

### 1. 素案の独自型は、避けたいと言っている当のものだった

MCP は OpenAI・Anthropic・Ollama・各種 Agent SDK が揃って消費する唯一のベンダ中立標準である。素案の未決事項リストは、ほぼそのまま MCP 仕様の目次だった。

| 素案の未決事項 | MCP の答え |
|---|---|
| `ToolResult` を string か structured か | `CallToolResult { content, structuredContent?, isError? }` |
| Permission の表現 | `ToolAnnotations` (`readOnlyHint` 等) |
| Plugin lifecycle | `initialize` → 稼働 → close |
| Plugin failure 時の挙動 | プロトコルエラー / 実行エラーの2系統 |
| Tool timeout / AbortSignal | `notifications/cancelled` |
| Tool 名の namespace 規則 | 「集約するクライアントはサーバ識別子を prefix せよ」 |
| Plugin registration 方式 | `tools/list` |
| JSON Schema validation | `inputSchema` / `outputSchema` |

独自に決め直せば、同じ問題を自前で解き、自前でドキュメント化し、自前で保守することになる。

### 2. 「対応しているツールをほぼ手を加えず Plugin にできる」の直接的な答え

MCP サーバとして既に公開されている weather / filesystem / fetch 等は、Tier 2 でコードを書かずに載る。素案の「将来候補」に挙がっていた能力の多くがこれで賄える。

### 3. レイテンシの懸念は該当しない

MCP の *型* を採用することに実行時コストは無い。Tier 1 の tool 呼び出しは `await tool.execute(args, ctx)` という素の関数呼び出しのままで、`{ content: [{ type: "text", ... }] }` を1個確保するだけである。

レイテンシが生じるのは JSON-RPC トランスポートを挟む Tier 2 のみ。

| | 実コスト |
|---|---|
| `save_memory` (embedding + Qdrant upsert) | 50〜300ms |
| `web_search` (SearXNG / OpenAI 往復) | 500〜3000ms |
| Tier 2 の stdio IPC 追加分 | 1〜5ms |

Tier 2 を使うのは元々ネットワーク I/O を伴うツールに限られるため、**レイテンシが問題になる場所と MCP のコストが乗る場所は重ならない。**

### 4. 現状の実装が既に MCP の解に近づいていた

- `ToolConfig.instructions` は MCP の `_meta` 拡張に相当する概念を先取りしている
- `web_search` は結果を `JSON.stringify({query, answer, results})` して返しており、これは `structuredContent` が解く問題を手で回避した状態である
- `mergeToolConfigs` の重複 tool 名拒否は、MCP の「prefix による曖昧性解消」が構造的に消す問題への対症療法である

移行は方向転換ではなく、既に向かっていた先を標準の形で受け取る作業になる。

### 5. `string` 固定の戻り値では表現できないものがある

`capture_obs_screenshot` のような画像を返す tool は、現在の `Promise<string>` では**そもそも型として表現できない**。`ContentBlock` の導入は将来の能力追加の前提条件である。

## 結果

### 得られるもの

- 未決事項の大半が仕様の参照で解決する
- 外部 MCP サーバがコード無しで載る
- プロバイダ変換が1箇所 (アダプタ層) に閉じる。`inputSchema` はどのプロバイダにもそのまま渡る
- `annotations` によりリスク語彙が標準化され、独自 permission 文字列の設計と保守が不要になる
- テストで MCP SDK のインメモリトランスポートを使えば、プロトコル越しに Plugin を検証できる

### 支払うもの

- `ToolDefinition.parameters` → `inputSchema` の改名。全 tool 定義に波及する
- 戻り値が `string` から `ToolResult` へ。移行期は自動包装のアダプタを挟む
- tool 名の prefix 化はモデルの挙動を変えうるため、**回帰テストが先に必要**
- Tier 2 を実装する場合 `@modelcontextprotocol/sdk` への依存が増える (Tier 1 のみなら依存ゼロ)
- MCP 仕様は改訂が速い (`2026-07-28` 時点で `resultType` / MRTR / `subscriptions/listen` が新しい)。バージョンを固定し、追随は意図的に行う

### 移行方針

既存を段階的に MCP 化する。新規に切り直して2形式を並存させることはしない (移行期間中 `mergeToolConfigs` の重複検出のような既存の安全装置が両形式にまたがらなくなるため)。段階は [Contract §11](../contracts/tool-plugin.md#11-既存-toolconfig-からの移行) を参照。

## 検討して採用しなかった案

### 案 A: 素案どおり独自 Contract を定義する

要件そのものに反する。MCP が解いた問題を自前で解き直す保守コストが継続的に発生し、外部 MCP サーバは載らない。

### 案 B: OpenAI の function calling 形式をそのまま正とする

現在の `ToolDefinition` に最も近く移行コストは最小。しかし特定ベンダの形式に固定され、Anthropic の `input_schema` や Gemini の `functionDeclarations` へは結局変換が要る。ベンダ中立という要件を満たさない。

### 案 C: 全 Plugin を MCP サーバとして実装する (Tier 2 のみ)

規格純度は最大だが、`save_memory` 1回ごとに JSON-RPC シリアライズと IPC を挟む。音声ボットのレイテンシ予算に対して割に合わず、テストにもプロセス起動が必要になる。

### 案 D: MCP 型のみ採用し、外部サーバ接続はしない

依存が増えないのは利点。ただし「既製ツールをほぼ手を加えず Plugin にできる」という要件の中核が実現しない。契約自体は Tier 2 を後から足せる形にしてあるため、Tier 2 の実装を後続 Phase に回すことは可能だが、**契約が独自規格化していないことを客観的に検証する手段が無くなる**点が問題になる。外部 MCP サーバが1本載ることを Phase 2 の Acceptance Criteria とする。
