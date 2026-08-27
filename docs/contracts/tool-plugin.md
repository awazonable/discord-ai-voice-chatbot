# Tool Plugin Contract

- 状態: 提案 (Phase 1 で確定)
- 準拠標準: [MCP (Model Context Protocol) `2026-07-28`](https://modelcontextprotocol.io/specification/latest/server/tools)
- 関連: [ADR 0001](../decisions/0001-mcp-tool-contract.md) / [設計レビュー](../architecture/core-plugin-review.md) / [改訂設計](../architecture/core-plugin.md)

Core と Plugin の唯一の接点を定義する。**Core は本ドキュメントの型以外で Plugin を知らない。**

---

## 1. 設計原則

1. **独自規格を作らない。** 型は MCP と構造的に一致させる。MCP に無い概念だけを `_meta` の名前空間キーで足す
2. **標準への一致は型の話であり、トランスポートの話ではない。** 自作 Plugin は素の TS オブジェクトとして直接呼ぶ (JSON-RPC を通さない)。MCP の型に揃えるのは、外部 MCP サーバを同じ Registry に載せられるようにするためと、プロバイダ変換を1箇所に閉じるため
3. **Plugin は Core の具象を知らない。** `PluginContext` 経由で依存を受け取る
4. **Core は Plugin の中身を知らない。** tool 名も指示文もスキーマも Plugin 側から来る

---

## 2. 型定義

### 2.1 `src/core/contracts/tool.ts`

```ts
/** JSON Schema。可搬サブセット(§4)に限定する。 */
export type JSONSchema = Record<string, unknown>;

/**
 * MCP `Tool` と構造的に同一。
 * プロバイダ固有の形への変換はアダプタ層(§6)が行う。
 */
export interface ToolDefinition {
  /** Plugin 内で一意なローカル名。^[a-zA-Z0-9_-]{1,38}$ (§3) */
  name: string;
  /** 表示用の人間向け名称。モデルには渡さない。 */
  title?: string;
  /** モデルが「いつ使うか」を判断できる説明。 */
  description: string;
  /** MCP: inputSchema。既存 ToolDefinition.parameters の後継。 */
  inputSchema: JSONSchema;
  /** structuredContent を返す場合に、その形を宣言する。 */
  outputSchema?: JSONSchema;
  annotations?: ToolAnnotations;
  /** MCP 予約の拡張点。独自項目は "zundamon/..." 名前空間で置く。 */
  _meta?: Record<string, unknown>;
}

/**
 * MCP `ToolAnnotations`。素案 §7 の独自 permission 文字列はこれで置き換える。
 * 未指定時は最も悲観的に解釈する — 破壊的・非冪等・open-world とみなす。
 */
export interface ToolAnnotations {
  /** 環境を変更しないか。既定 false */
  readOnlyHint?: boolean;
  /** 変更が破壊的(追加的でない)か。既定 true */
  destructiveHint?: boolean;
  /** 同じ引数で再実行して安全か。既定 false */
  idempotentHint?: boolean;
  /** サーバの管理外の外部サービスに触れるか。既定 true */
  openWorldHint?: boolean;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string };

/**
 * MCP `CallToolResult`。
 * content はモデルへ渡すテキスト、structuredContent は機械可読な値。
 * MCP の指針に従い、structuredContent を返す場合は同じ内容の JSON 文字列を
 * text ブロックにも入れる(プロバイダ非対応時の後方互換)。
 */
export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  /** true = ツール実行エラー。モデルに返して自己修正させる(§5)。 */
  isError?: boolean;
}

/** Runtime が Plugin へ渡す実行文脈。 */
export interface ToolExecutionContext {
  /** 呼び出し元の中断 + tool 単位の timeout 予算を合成したもの(§7)。 */
  signal: AbortSignal;
  caller: ToolCaller;
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
  /** 長時間ツールの進捗。session が繋ぎ発話の判断に使う。 */
  reportProgress?(progress: number, total?: number, message?: string): void;
}

export interface ToolCaller {
  sessionId: string;
  /** Discord の話者。Plugin は識別子としてのみ扱い、外部へ出さない。 */
  speakerId?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Tool {
  definition: ToolDefinition;
  /** args は inputSchema で検証済み。Plugin 側での再検証は不要。 */
  execute(args: unknown, ctx: ToolExecutionContext): Promise<ToolResult>;
}
```

### 2.2 `src/core/contracts/plugin.ts`

```ts
import type { LogLevel, Tool } from "./tool.js";

/** MCP `Implementation` (serverInfo) 相当。 */
export interface PluginManifest {
  /** Registry 内で一意。tool 名の prefix になる。^[a-z][a-z0-9-]{0,23}$ (§3) */
  id: string;
  /** semver。Contract 変更時の互換判定に使う。 */
  version: string;
  title?: string;
  description: string;
  _meta?: Record<string, unknown>;
}

/**
 * Plugin が Core から受け取る唯一の依存。
 * グローバルや import による具象取得を禁じ、テストで差し替え可能にする。
 */
export interface PluginContext {
  /** この Plugin の名前空間の設定スライス。AppConfig 全体は渡さない。 */
  config: Readonly<Record<string, unknown>>;
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
  /** アプリ終了に連動。initialize 中の長時間処理はこれを見る。 */
  signal: AbortSignal;
  /** テストで固定時刻に差し替えるための時刻源。Date.now() を直接呼ばない。 */
  now(): number;
}

export interface ToolPlugin {
  manifest: PluginManifest;
  /** 起動時に1回。失敗時の扱いは §8。 */
  initialize?(ctx: PluginContext): Promise<void>;
  /**
   * MCP `tools/list` 相当。
   * 配列フィールドではなくメソッドにするのは、外部 MCP サーバのように
   * 認証状態で tool 集合が変わる実装を同じ型で扱うため。
   */
  listTools(): Promise<Tool[]> | Tool[];
  /**
   * モデルへ渡す、この Plugin のツール群の使い方の指示。
   * dev の ToolConfig.instructions をそのまま引き継ぐ。
   */
  instructions?(): string[];
  dispose?(): Promise<void>;
}
```

### 2.3 `src/core/contracts/runtime.ts`

```ts
import type { ToolCaller, ToolDefinition, ToolResult } from "./tool.js";

/** LLM クライアントが受け取る協力者。ToolConfig の後継。 */
export interface ToolRuntime {
  /** プロバイダへ提示する定義一覧。name は prefix 済み(§3)。 */
  listDefinitions(): ToolDefinition[];
  /** Plugin 由来の指示文を連結したもの。session の system prompt へ。 */
  instructions(): string[];
  /**
   * name は prefix 済みの公開名。argsJson はモデルが生成した生の JSON 文字列。
   * 例外は投げない — 失敗は必ず ToolResult(isError) として返す(§5)。
   */
  call(name: string, argsJson: string, caller: ToolCaller, signal: AbortSignal): Promise<ToolResult>;
}
```

---

## 3. Tool 命名規則

プロバイダ側の制約が最も狭いため、そこに合わせる。

| 対象 | 規則 |
|---|---|
| Plugin id | `^[a-z][a-z0-9-]{0,23}$` (小文字ケバブ、24文字以内) |
| Tool ローカル名 | `^[a-zA-Z0-9_-]{1,38}$` |
| **公開名 (プロバイダへ渡す名)** | `` `${pluginId}__${localName}` `` — **アンダースコア2つ**区切り |
| 公開名の全体制約 | `^[a-zA-Z0-9_-]{1,64}$` — 登録時に強制 |

例: `long-term-memory__save_memory`, `web-search__web_search`

### なぜドットではないのか

- OpenAI の function `name` は `a-z A-Z 0-9 _ -` のみ、最大64文字。**ドットは使えない**
- Anthropic も同等
- MCP はサーバ *内* ではドットを許すが、複数サーバを束ねて1つの tool 配列へフラット化した時点で通らなくなる
- MCP 仕様自体が「集約するクライアントはサーバ識別子を prefix せよ」と明記している
- `mcp__server__tool` は Claude Code をはじめとする MCP クライアントの事実上の標準

### 外部 MCP サーバ由来の名前

ドットを含む名前 (`admin.tools.list` は MCP では合法) は `_` へ置換した上で prefix する。置換後に衝突が生じた場合はマウントを失敗させ、どのサーバのどの tool が衝突したかを名指ししてログに出す。

### 移行時の注意

現行の `save_memory` / `search_memory` / `web_search` はいずれも prefix 無しである。改名はモデルの挙動を変えうるため (`docs/overall-design.md:110-114` が指示文の言い回しが load-bearing だと記録している)、**Phase 0 の回帰テストが入ってから**行う。

---

## 4. 可搬 JSON Schema サブセット

Plugin が「特定プロバイダでしか動かないスキーマ」を持ち込むのを防ぐため、Registry 登録時に検証する (`assertPortableSchema()`)。

### 必須

- ルートは `{ "type": "object", "properties": {...}, "required": [...], "additionalProperties": false }`
- ネストした object も `additionalProperties: false` を持つ
- すべてのプロパティに `description` がある (モデルの判断材料になる)

### 使ってよい

`string` / `number` / `integer` / `boolean` / `array` (`items` 必須) / `object` / 文字列 `enum` / nullable を表す `type: ["string", "null"]`

### 使ってよいが強制されない — Plugin 側で再検証すること

`minimum` / `maximum` / `minLength` / `maxLength` / `pattern`

プロバイダによって扱いが異なり、OpenAI の `strict: true` では無視されうる。`save_memory` の `importance` (`minimum: 1, maximum: 5`) はこれに該当し、範囲外の値が来る前提で実装する必要がある。

### 使ってはいけない

`$ref` / `$defs` / `allOf` / `oneOf` / `not` / `patternProperties` / `additionalProperties: true` / `format`

`format` は意味論がプロバイダごとに揺れるため、`description` に自然文で書く。

### `strict: true` について

OpenAI の `strict: true` は「全プロパティが `required`」も要求する。optional 引数は `required` に入れた上で `type: ["string", "null"]` として表現し、Plugin 側で `null` を「未指定」として扱う。

> 現状 `web_search` (`language` / `time_range` が optional) も `save_memory` (`category` / `importance` が optional) も strict では通らない。Phase 1 でどちらも上記の形へ揃える。

---

## 5. エラー処理

MCP の2系統モデルを採る。**この区別は「モデルに見せるか」で決まる。**

### プロトコルエラー — モデルに詳細を見せない

未知の tool 名、`inputSchema` に対する引数検証失敗、Plugin の内部不整合。モデルが引数を直しても解決しない類のもの。

- Runtime は完全な内容を `callLogger` へ記録する
- モデルへは**サニタイズした短い文言**を `isError: true` で返す (例: `ツールを実行できませんでした`)
- 例外として、引数検証失敗は「どのフィールドが不正か」までは返してよい (モデルが直せるため)

### ツール実行エラー — モデルに返して自己修正させる

外部 API の失敗、業務ロジック上のエラー、タイムアウト。

- Plugin は例外を投げるのではなく `{ content: [...], isError: true }` を返すのが正
- ただし例外を投げた場合も Runtime が同じ形へ変換する (Plugin 実装の取りこぼしを Core が吸収する)
- 文面はモデルが次の手を選べる具体性にする (例: `検索がタイムアウトしました。より短いクエリで再試行できます`)

### サニタイズ

**Runtime はモデルへ渡す前に必ずサニタイズする。**

- 設定由来の秘密値 (`apiKey`、`baseURL`、`qdrantURL`、SearXNG の URL) と一致する部分文字列を伏字にする
- 認証情報を含む URL (`https://user:pass@...`) を除去する
- 長さ上限を設ける

現状 `openaiClient.ts:165-167` は `エラー: ${err.message}` をそのままモデルへ渡しており、`SearXNGSearchProvider` や `EmbeddingClient` の接続エラーが baseURL ごと LLM 文脈へ入りうる。

---

## 6. プロバイダ変換表

`inputSchema` はどのプロバイダにもそのまま渡る。差異は包み方だけで、アダプタは各20行程度。

| プロバイダ | tool 定義の形 |
|---|---|
| OpenAI Chat Completions (現行) | `{ type: "function", function: { name, description, parameters: inputSchema } }` |
| OpenAI Responses | `{ type: "function", name, description, parameters: inputSchema, strict }` |
| Anthropic Messages | `{ name, description, input_schema: inputSchema }` |
| Ollama `/api/chat` | OpenAI Chat Completions と同形 |

### 結果 → プロバイダのメッセージ

1. `content` の `text` ブロックを `\n` で連結する
2. text が空で `structuredContent` があれば `JSON.stringify(structuredContent)` を使う
3. `image` / `audio` はプロバイダが対応していれば multimodal tool result にする。非対応なら `[image: image/png]` 等のプレースホルダに置換し、実体は `events` 経由で別途扱う
4. `isError: true` もそのまま文字列としてモデルへ返す (自己修正のため) + `callLogger` へ記録する

### プロバイダ固有の癖はアダプタに閉じる

`openaiClient.ts:78-81` の `reasoning_effort: "none"` (gpt-5.6 系が tools 併用時に 400 を返す回避策) はアダプタ層の明示的な設定として持つ。**Plugin 作者が無自覚に踏む位置に置かない。**

---

## 7. レイテンシとキャンセル

リアルタイム音声ボットであるため、**tool 実行時間はそのまま無音時間**になる。

### レイテンシ級の宣言

```ts
_meta: { "zundamon/latencyClass": "fast" | "normal" | "slow" }
```

| 級 | 想定 | 既定 timeout | 繋ぎ発話 |
|---|---|---|---|
| `fast` | ローカル計算のみ、<200ms | 2s | なし |
| `normal` | ローカルサービス (Qdrant 等)、<1s | 5s | なし |
| `slow` | 外部ネットワーク、>1s | 15s | あり |

未宣言の tool と外部 MCP サーバ由来の tool は `slow` とみなす (最も悲観的な既定)。サーバ単位の設定で上書きできる。

### timeout の強制

Runtime が合成する。

```ts
const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(budget)]);
```

現状 `ToolCallHandler` の `signal?: AbortSignal` は optional で、`createMemoryToolConfig` は受け取ってすらいない。**Plugin が signal を無視してもラウンド全体をハングさせない**ために、予算の強制は Core 側の責務とする。

### 繋ぎ発話

実行が閾値 (~800ms) を超えたら Runtime がイベントを出し、session が「ちょっと待つのだ」等を発話できるようにする。Tier 2 では MCP の progress 通知がこの信号になる。

---

## 8. ライフサイクル

```
initialize(ctx)  →  listTools() / instructions()  →  call() ...  →  dispose()
```

- `initialize` は起動時に1回。失敗した Plugin は**登録せず、Bot は残りの Plugin で起動する** (素案 §10「Long-term Memory を無効化しても会話は成立する」の一般化)
- 起動失敗はログに残し、`describeConfig` 相当の起動時サマリに「無効化された Plugin」として表示する
- `listTools()` は `initialize` 後に呼ばれる。呼ばれるたびに評価してよい
- `dispose` はアプリ終了時。`discordBot.ts` の `cleanup()` から呼ぶ

---

## 9. MCP 対応表

| 本 Contract | MCP | 備考 |
|---|---|---|
| `ToolDefinition` | `Tool` | `parameters` → `inputSchema` に改名 |
| `ToolAnnotations` | `ToolAnnotations` | そのまま |
| `ContentBlock` | content types | text / image / audio / resource_link のサブセット |
| `ToolResult` | `CallToolResult` | `resultType` は Tier 1 では不要。Tier 2 でクライアントが解釈する |
| `PluginManifest` | `Implementation` (serverInfo) | `id` ↔ `name` |
| `ToolPlugin.listTools()` | `tools/list` | |
| `ToolRuntime.call()` | `tools/call` | |
| `ToolPlugin.initialize()` | `initialize` | |
| `ToolExecutionContext.signal` | `notifications/cancelled` | |
| `reportProgress` | `notifications/progress` | |
| `_meta` | `_meta` | 独自拡張の唯一の置き場 |

**MCP に無く、こちらで足したもの**: `instructions()` (ツール群の使い方の指示文)、`zundamon/latencyClass`。前者は dev の `ToolConfig.instructions` を引き継いだもので、MCP の `prompts` 機能とは目的が異なる。

---

## 10. 外部 MCP サーバのマウント (Tier 2)

`@modelcontextprotocol/sdk` のクライアントで stdio / Streamable HTTP のサーバへ接続し、`ToolPlugin` として包む。

```
McpServerPlugin implements ToolPlugin
  manifest.id  ←  設定で与える識別子 (serverInfo.name は一意性が保証されない)
  initialize() →  transport 接続 + initialize ハンドシェイク
  listTools()  →  tools/list の結果を Tool[] へ変換
  execute()    →  tools/call
  dispose()    →  transport close
```

MCP 仕様は `serverInfo.name` の一意性を保証しないと明記しているため、**prefix には設定側で与えた id を使う**。

---

## 11. 既存 `ToolConfig` からの移行

dev の `ToolConfig` / `mergeToolConfigs` は本 Contract の直系の前身であり、段階的に移行する。各段階で動く状態を保つ。

| 段階 | 変更 | 互換 |
|---|---|---|
| 1 | `ToolRuntime` を導入し、`ToolConfig` を包むアダプタを置く。`streamChat` の第3引数を差し替える | 既存 Plugin は無変更 |
| 2 | `inputSchema` による引数検証と timeout 予算を Runtime へ集約。Plugin 側の手書きバリデータを削除できる | `parseWebSearchArgs` が不要になる |
| 3 | `ToolResult` を導入。string を返す既存 `onCall` は `{ content: [{ type: "text", text }] }` へ自動包装 | 段階的 |
| 4 | tool 名を prefix 化 | Phase 0 の回帰テスト必須 |
| 5 | `ToolPlugin` へ移行し、`ToolConfig` を廃止 | |

`mergeToolConfigs` の重複検出は Registry の登録時検証として引き継ぐ。prefix 化 (段階4) 以降は衝突が構造的に起きなくなるが、保険として残す。

---

## 12. Plugin に対するテスト要件

Plugin は以下を満たすこと。素案 §8 の条件を Contract 側から強制する形になっている。

- `PluginContext` のモックだけで初期化できる (Discord / LLM / VOICEVOX を起動しない)
- 外部依存は `PluginContext.config` 経由で注入される。グローバルや直接 import で具象を取らない
- 時刻は `ctx.now()` から取る。`Date.now()` を直接呼ばない
- `execute` は `ctx.signal` の中断に応答する
- 外部サービスへ触れる Plugin は、その通信部分をインターフェースとして切り出す (`SearchProvider` が既にこの形。`LongTermMemory` は未対応)

テストコマンド: `npm test -- --test-name-pattern "<plugin-id>"`

---

## 13. バージョニング

- `PluginManifest.version` は semver
- Contract 自体のバージョンは本ドキュメントの改訂で表す。破壊的変更は ADR を伴う
- Contract を変更する場合、**全 Plugin のテストを実行する** (素案 §Agent開発ルール)
- Plugin 開発 Issue では Contract を変更しない。不足が判明したら提案し、人間のレビューを経て別 Issue にする (素案 §16)
