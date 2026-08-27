# Core / Plugin 分離 設計素案レビュー

- 対象: 「Core / Plugin 分離・エージェント開発基盤 設計素案」(2026-08)
- レビュー基準コード: `dev` (`2af3896`, web search 導入後)
- 改訂設計: [`core-plugin.md`](./core-plugin.md)

素案の方向性 — Core/Plugin の2層構成、Adapter 分離の見送り (YAGNI)、Human-Gated Autonomy、Issue Scope の明示 — はいずれも妥当であり、そのまま維持する。

本ドキュメントは、現行コードを読んだ上で判明した **素案が前提にしている土台が実在しない箇所** と、**素案自身が「独自規格を避けたい」という要件に反している箇所** を記録する。

---

## 0. `dev` で既に解決済みの項目

素案は `main` 時点を前提に書かれているが、`dev` の web search 導入 (PR #12) が素案の課題のうち3つを既に解いている。**これらは再提案しない。**

| 課題 | `dev` での解決 |
|---|---|
| Core が Plugin の tool 名を system prompt に直書き | `ToolConfig.instructions?: string[]` が追加され、`zundamonSession.ts:353` は `this.tools?.instructions?.join(" ")` するだけになった。memory の指示文は `createMemoryToolConfig` 側 (`memoryTools.ts:71-73`) へ移動済み |
| `onCall` に `AbortSignal` が渡らない | `ToolCallHandler` に `signal?: AbortSignal` が追加され、`openaiClient.ts:164` が `tools.onCall(tc.name, tc.args, signal)` で渡している |
| 複数の Plugin を1つの LLM 呼び出しへ合成できない | `src/llm/toolConfig.ts` の `mergeToolConfigs()` が `definitions` / `instructions` を連結し、tool 名で owner を引いて dispatch する。重複 tool 名は起動時に例外で拒否 |

`web_search` (`src/webSearchTools.ts`) 側の品質も高い。`additionalProperties: false` 付きスキーマ、手書きの引数バリデーション (`parseWebSearchArgs`)、プロンプトインジェクション対策を明記した instructions、`SearchProvider` によるバックエンド抽象化が揃っている。

**したがって本レビューの残りの指摘は、この到達点を前提とした上での差分である。**

---

## A. 「独自規格を避けたい」に対する評価

### A-0. 素案 §5/§7 は独自規格になっている

素案の `ToolPlugin` / `PluginManifest` / `Tool` と、独自 permission 文字列 (`memory.read`, `network.http` 等) は、**MCP (Model Context Protocol) が既に標準化している領域を再発明している**。

MCP は OpenAI・Anthropic・Ollama・各種 Agent SDK が揃って消費する唯一のベンダ中立標準であり、素案 §20 の未決事項の大半は MCP 仕様 (現行 `2026-07-28`) に既に答えがある。

| 素案 §20 の未決事項 | MCP における答え |
|---|---|
| `ToolResult` を string か structured か | `CallToolResult { content: ContentBlock[]; structuredContent?; isError? }` — 両方持つ |
| Permission の表現 | `ToolAnnotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`)。未注釈時は「破壊的・非冪等・open-world」と最も悲観的に解釈するのが仕様の既定 |
| Plugin lifecycle | `initialize` → 稼働 → transport close |
| Plugin failure 時の Core 挙動 | **2系統に分離**。プロトコルエラー (未知ツール・スキーマ不整合) は JSON-RPC error、ツール実行エラーは `isError: true` を結果に載せてモデルに返し自己修正させる |
| Tool timeout / AbortSignal | `notifications/cancelled`、SDK が `AbortSignal` を提供 |
| Tool 名の namespace 規則 | 仕様が明記 — 複数サーバを束ねるクライアントは「サーバ識別子を prefix する」 |
| Plugin registration 方式 | `tools/list` (動的・`listChanged` 通知あり) |
| JSON Schema validation | `inputSchema` / `outputSchema`、既定 draft 2020-12 |

独自拡張が必要になった場合の作法も MCP 側が用意している。予約フィールド `_meta` に逆DNS風の名前空間キー (例: `zundamon/latencyClass`) で載せれば、標準をフォークせずに済む。

> **レイテンシについての誤解を避けるための注記**
> MCP の *型* を採用することに実行時コストは無い。Tier 1 (in-process) の tool 呼び出しは `await tool.execute(args, ctx)` という素の関数呼び出しのままで、`{ content: [{ type: "text", ... }] }` を1個確保するだけである。
> レイテンシが生じるのは JSON-RPC トランスポートを挟む Tier 2 (外部 MCP サーバ) だけで、温まったプロセスで 1〜5ms 程度。そして Tier 2 を使うのは元々ネットワーク I/O を伴うツールに限られる (`web_search` の実測レンジは 500〜3000ms) ため、**レイテンシが問題になる場所と MCP のコストが乗る場所は重ならない。**

### A-1. 【要修正】tool 名がフラットで、衝突が起動失敗になる

素案 §6 の図が示すドット区切りの `memory.save_memory` は、**プロバイダ側の制約に違反する**。

- OpenAI の function `name`: `a-z A-Z 0-9 _ -` のみ、最大64文字。**ドット不可**
- Anthropic も同等の制約
- MCP はサーバ *内* ではドットを許すが、複数サーバを束ねて provider の tool 配列にフラット化した瞬間に破綻する

現状の `dev` は `save_memory` / `search_memory` / `web_search` が全てフラットで、`mergeToolConfigs` が重複を**起動時 throw** で防いでいる。

```ts
if (owners.has(definition.name)) {
  throw new Error(`ツール名が重複しています: ${definition.name}`);
}
```

これは正しい防御だが、意味するところは「2つの Plugin が両方 `search` という tool を持ったら Bot が起動不能になる」である。Plugin をエージェントが追加していく前提では、いずれ踏む。

**採用する規則**: `<plugin_id>__<tool_name>` (アンダースコア2つ)。Claude Code 自身が `mcp__server__tool` で採用している事実上の標準であり、MCP 仕様の「サーバ識別子を prefix せよ」という指示も満たす。登録時に `^[a-zA-Z0-9_-]{1,64}$` を検証し、外部 MCP サーバ由来のドット入り名は `_` へサニタイズした上で衝突検出する。prefix があれば衝突は構造的に消え、`mergeToolConfigs` の throw は保険として残る。

### A-2. 【要追加】スキーマの可搬性を登録時に検証する

`dev` の2つの tool 群で既にスキーマ規約が食い違っている。

| | `additionalProperties` | optional 引数の扱い |
|---|---|---|
| `web_search` (`webSearchTools.ts:16-38`) | `false` 有り | `language` / `time_range` が `required` に無い |
| `save_memory` / `search_memory` (`memoryTools.ts:14-35, 43-55`) | **未指定** | `category` / `importance` が `required` に無い |

OpenAI の `strict: true` は「全 object に `additionalProperties: false`」かつ「全プロパティが `required`」(optional は `type: ["string","null"]` で表現) を要求するため、**両方とも strict では通らない**。Gemini はさらに狭い OpenAPI サブセットしか受けない。

規約が人間の注意力だけで維持されている状態であり、エージェントが Plugin を書き始めればさらに乖離する。**Registry 登録時に可搬スキーマサブセットを検証する** (`assertPortableSchema()`)。素案テスト戦略の `architecture-check` の一部として機械的に効かせられる。

### A-3. 【要修正】`ToolResult` が string 固定で、構造化結果が手作業で潰されている

`ToolCallHandler` の戻り値は `Promise<string>` のままである。そのため `web_search` は結果を自前で JSON 文字列化している (`webSearchTools.ts`)。

```ts
return JSON.stringify({
  query: response.query,
  ...(response.answer ? { answer: response.answer } : {}),
  results: response.results,
});
```

一方 memory 側は人間向けの日本語散文を返す (`保存しました: "..." (category=...)`)。同じ「tool の結果」が Plugin ごとに別形式で、Core は中身を一切扱えない。

MCP の `CallToolResult` は `content` (モデル向けテキスト) と `structuredContent` (機械可読な値) を分けて持ち、`outputSchema` で後者を検証できる。これを採れば `web_search` の手作業のシリアライズが契約側に吸収される。将来 `capture_obs_screenshot` のような画像を返す tool は、string 固定のままでは**そもそも表現できない**。

### A-4. 二層構成にする

- **Tier 1 / in-process**: 自作 Plugin は MCP 型に一致した素の TS オブジェクト。JSON-RPC を通さない。`long-term-memory` / `web-search` はこちら
- **Tier 2 / 外部 MCP**: `@modelcontextprotocol/sdk` のクライアントで stdio / Streamable HTTP の既存 MCP サーバをマウントし、`tools/list` の結果を同じ Registry へ流し込む

両者が Registry 上で同一の `Tool` レコードになるため、**Core のコードパスは1本**。weather / filesystem / Discord history 等はコードを書かずに入る。

> **契約が独自規格化していないことの受け入れ条件**
> 「既製の外部 MCP サーバを1本マウントして、Core を一切変更せずに動く」ことを Phase 2 の Acceptance Criteria に入れる。これが唯一の客観的な検証手段。

---

## B. コードを読んで判明した、素案が扱っていない事項

### B-1. 【最優先】tool 呼び出しの E2E 経路を検証する手段が無い

`dev` で `test/searchTools.test.ts` / `test/searchProviders.test.ts` が追加され、`node:assert/strict` を使うようになった。`mergeToolConfigs` の合成・重複拒否・dispatch は**単体で検証できている**（素案テスト戦略の階層2のうち `ToolRuntime + MockPlugin` 相当は成立している）。

しかし残る欠落が大きい。

- **`MockLLMClient` は `dev` でも `tools` 引数を捨てている** (`src/llm/mockClient.ts` — 「tools は現状ロジック検証用のモックでは未対応」)。したがって「モデルが tool 呼び出しを選ぶ → `openaiClient` のループ → `onCall` → 結果を会話へ積んで継続」という**経路全体が一度も自動検証されていない**
- `test/fakeOpenAIServer.ts` に tool_calls の SSE 応答が無い
- テストフレームワークが無く、`npm test` も無い。`test:*` スクリプトが10本あり個別に叩く必要がある (`test:web-search` は `&&` で2本を連結している)
- CI が無い (`.github/` 自体が存在しない)
- Linter が無い
- `README.md:81` が「memory ツールは E2E 未検証」と自認している

**tool 呼び出しをスクリプトできる Mock LLM が無い限り、Contract 変更・tool 名の prefix 化・結果形式の変更はいずれも回帰を検出できない。** これを Phase 0 として移行前に置く。

### B-2. Tool ループは既に存在する — `OpenAILLMClient` の中に

素案 §6 は「Tool Runtime」を新しい箱として描くが、ループは既に `src/llm/openaiClient.ts:63-176` にある (`MAX_TOOL_ITERATIONS = 6`)。

**ループは動かさない。** ストリーミングの delta 再構築 (`tool_calls` が chunk 間で分割される — `openaiClient.ts:102-112`) と、`finally` での `stream.controller.abort()` (`openaiClient.ts:121-136` — 課金トークンを止めるために必要) に強く絡んでおり、移設は高リスクで見返りが小さい。

代わりに **`streamChat` の第3引数を `ToolConfig` から `ToolRuntime` 協力者へ差し替える**。`openaiClient.ts:164` の1行が `await runtime.call(name, argsJson, ctx)` になるだけで、検証・権限・timeout・キャンセル・ログが Runtime 側の1箇所に集まる。`mergeToolConfigs` は `ToolRuntime` の内部実装として素直に発展させられる。

### B-3. AbortSignal は通ったが、timeout の強制がまだ無い

`signal` は `onCall` まで届くようになったが、型は `signal?: AbortSignal` の **optional** であり、Plugin 側が無視しても型検査は通る。実際 `createMemoryToolConfig` の `onCall` は `signal` を受け取っていない (`memoryTools.ts:74`)。

- Plugin が signal を無視した場合にラウンド全体をハングさせないための **tool 単位の timeout 予算が Core 側に無い**
- `signal` は LLM ストリームの AbortSignal をそのまま流用しており、「この tool だけ 5 秒で打ち切る」ができない

Runtime 側で tool ごとに `AbortSignal.any([callerSignal, AbortSignal.timeout(budget)])` を合成して渡す。

### B-4. 【素案に完全に欠落】レイテンシとターンテイキング

これはリアルタイム音声ボットであり、**tool 実行時間はそのまま無音時間**。素案には一切記述が無い。

`dev` で `web_search` が入ったことでこれは仮定ではなく現実の問題になった。SearXNG 往復ないし OpenAI web search 経由で数百ms〜数秒かかり、その間ボットは黙る。`SearchConfig.timeoutMs` はプロバイダ内部の HTTP timeout であって、**セッション層は tool がどれだけ待たされるかを知らない**。

契約に後付けするとシグネチャを再度変えることになるため Phase 1 で決める。

- 各 tool が期待レイテンシ級を宣言 (`_meta` の名前空間キー)。外部 MCP サーバは値を持たないので Runtime 側の既定値 + サーバ単位の設定で上書き
- Runtime が tool 単位の timeout 予算を強制 (B-3)
- 閾値 (~800ms) 超過時に session が繋ぎ発話を出せるフックを置く。Tier 2 では MCP の progress 通知がその信号になる

### B-5. エラーが握り潰されてモデルの文脈に混入している

`openaiClient.ts:161-172` は例外を捕まえて `エラー: ${message}` という文字列を tool 結果としてモデルに返す。方向性は MCP の `isError: true` に近く正しいが:

- 「未知のツール」(プロトコルエラー — `mergeToolConfigs` と各 `onCall` の両方が投げる) と「SearXNG が落ちている」(実行エラー) が同一に扱われる
- どちらもログにも session にも上がらない
- **生のエラーメッセージが接続文字列や API キーを LLM 文脈へ漏らしうる**。`SearXNGSearchProvider` / `EmbeddingClient` は baseURL を持つため現実的なリスク

MCP の2系統モデルを採用し、Runtime でサニタイズする。

### B-6. 観測性: tool 呼び出しに専用のログ種別が無い

`src/llm/callLogger.ts:15` の `kind` は `"main" | "judge"` のみで、tool 呼び出しは `responseText` に `[tool_calls: a, b]` という合成文字列として押し込まれている (`openaiClient.ts:129-132`)。Plugin が N 個になるとここが唯一のデバッグ面になる。`kind: "tool"` を追加し plugin id / tool 名 / 所要時間 / `isError` を記録する。エージェントが書いた Plugin をデバッグ可能にするための低コストな投資。

### B-7. tool を渡すと `reasoning_effort: "none"` が強制される

`openaiClient.ts:78-81`。gpt-5.6 系が `/v1/chat/completions` 経由の function tools を拒否する (400) ための回避策だが、**「どの tool か」ではなく「tool が1つでもあるか」で効く**。

`dev` で `SEARCH_BACKEND=disabled` にしても memory tools が残るため常に発火する状態であり、Plugin モデル下ではさらに「任意の Plugin を1つ有効にしただけで全ターンの本体モデルの推論品質が静かに下がる」ことになる。プロバイダアダプタ内に明示的な設定として置き、Plugin 作者が無自覚に踏まないようにする。回避策が今も必要かの再検証も併せて。

### B-8. 引数バリデーションが Plugin ごとにばらついている

`web_search` は `parseWebSearchArgs` で JSON パース失敗・型・enum・正規表現まで丁寧に検証している (`webSearchTools.ts`)。一方 memory 側は `JSON.parse(argsJson) as SaveArgs` の**無検査キャスト**のままである (`memoryTools.ts:73, 82`)。

同じ検証を Plugin ごとに手書きさせる限り、品質は書いた人次第になる。`inputSchema` を持っているのだから **Runtime が一元的に検証すべき**で、そうすれば Plugin 側の手書きバリデータは消える。素案 §20 の「JSON Schema validation の実装」はここに効く。

### B-9. `LongTermMemory` が具象を直接 new している

`src/memory/longTermMemory.ts:46` が `new QdrantClient(...)` を構築し、`EmbeddingClient` を型ではなく値として import している (同 `:3`)。素案 §8「Mock `PluginContext` でテスト可能」を満たすには `VectorStore` / `Embedder` インターフェースの抽出が要る。

なお `dev` の `SearchProvider` (`src/search/types.ts`) は**まさにこの形が既にできている** — バックエンド非依存の最小契約があり、`MockSearchProvider` でテストできる。memory 側を同じ形に揃えるのが Phase 3 の実作業。

### B-10. Plugin 相当のコードの置き場所が既に割れている

| tool 群 | 実装の場所 |
|---|---|
| memory | `src/memory/memoryTools.ts` (サブディレクトリ) |
| web search | `src/webSearchTools.ts` (**`src/` 直下**) + `src/search/` |

`src/` 直下は既に20本のデモ/プローブスクリプトで混雑しており (全ソース LOC の41%)、Plugin 実装がそこに混ざると境界が見えなくなる。素案 §9 のディレクトリ規約は、この乖離が広がる前に決めるべき。

---

## C. エージェント基盤 (AGENTS.md / CI)

### C-1. 【ブロッカー】`CLAUDE.md` が `.gitignore` されている

`.gitignore` の最終行に `CLAUDE.md` (commit `5dc088c`「CLAUDE.mdをgitignoreに追加」)。素案 §11 は Claude Code 互換のため `CLAUDE.md` をコミットする前提なので、**まずこの行を外さないと §11 は成立しない**。

### C-2. 【要修正】素案 §12 の階層 AGENTS.md は Claude Code では動かない

Claude Code は **`AGENTS.md` を読まない** (公式ドキュメントに明記)。かつサブディレクトリで発見されるのは `CLAUDE.md` であって `AGENTS.md` ではない。したがって素案 §12 の

```
plugins/AGENTS.md
plugins/long-term-memory/AGENTS.md
```

は Claude Code から**完全に不可視**になる。

**修正**: 各コンポーネントディレクトリに `CLAUDE.md` を置く。二重管理を避けるならシンボリックリンクが最善 (内容ゼロ)。

```bash
ln -s AGENTS.md CLAUDE.md   # 各コンポーネントディレクトリで
```

ルートだけは Claude 固有の追記ができるよう import 形式にする。

```markdown
@AGENTS.md

## Claude Code
（Claude 固有の指示があればここ）
```

Claude Code 単体なら `.claude/rules/` + `paths:` frontmatter がこの用途に設計された機能でより上等だが、Codex 側が AGENTS.md 階層を読むため、**AGENTS.md を正とし CLAUDE.md をリンクにする**のが可搬性のある答え。

### C-3. 【落とし穴】Safety ドキュメントを `@import` してはいけない

素案 §13 は「外部I/O等を扱う Issue のときだけ詳細 Safety 文書を参照させる」としているが、`CLAUDE.md` 内の `@docs/agent/safety.md` は**起動時に必ず全文がロードされる** (import は遅延しない)。目的が達成できない。

パスをバッククォートで囲む (`` `docs/agent/safety.md` ``) と import として解釈されず、単なる参照として残る。これが正しい書き方。

### C-4. `CLAUDE.md` は200行以下を目標に

素案 §11「巨大化させない」の具体的な数値。公式ドキュメントが200行を推奨閾値としている。

### C-5. 【要修正】素案 §19「import 境界を TypeScript で表現する」— tsc にその機能は無い

`tsc` に import 境界の強制機能は無い。`dependency-cruiser` か `eslint-plugin-boundaries` が要る。これが素案テスト戦略の `architecture-check` の実体。

```
禁止: src/**         →  plugins/**
禁止: plugins/a/**   →  plugins/b/**
許可: plugins/**     →  src/core/contracts/** のみ
```

**§4 の依存ルールのうち機械的に効くのはここだけ**であり、これが無ければ §4 は「エージェントがいずれ逸脱する文書上の慣習」に留まる。費用対効果が最も高い。

なお `dev` が `instructions` を導入したことで、`main` 時点にあった「session が tool 名を文字列で知っている」という *import 境界では捕捉できない* 依存は既に解消されている。この種の依存を作らない設計を維持することが前提となる。

### C-6. Phase 1 を単独で走らせない

消費者ゼロで設計された契約は必ず間違う。**Phase 1 と 2 を1本の垂直スライスにまとめ、消費者で検証する**。

`dev` の時点で消費者は既に2つある (`long-term-memory` と `web-search`) ため、素案が書かれた時点より条件は良い。そこへ**既製の外部 MCP サーバ1本**を加えて3つ目の消費者とすれば、契約が自作 Plugin の形に歪んでいないことを確認できる。

### C-7. `plugins/` の配置 — ルート直下

`tsconfig.json` は `noEmit: true` でビルド段階が無い (`tsx` で直接実行) ため、`rootDir` / `outDir` の制約が効かない。**ルート直下 `/plugins/` のコストは `include` に1行足すだけ**。境界がエージェントから見て一目瞭然になる利点を取る (B-10 の解消も兼ねる)。

```json
"include": ["src/**/*.ts", "test/**/*.ts", "plugins/**/*.ts"]
```

新規ファイルでも **相対 import の `.js` 拡張子は必須** (`moduleResolution: "bundler"` だが実行は tsx/ESM で全ファイルが `.js` 付き)。

---

## 参照

- MCP 仕様 (Tools, `2026-07-28`): https://modelcontextprotocol.io/specification/latest/server/tools
- OpenAI function calling: https://developers.openai.com/api/docs/guides/function-calling
- Claude Code メモリ (CLAUDE.md / AGENTS.md): https://code.claude.com/docs/en/memory
