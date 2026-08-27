# Core / Plugin アーキテクチャ

- 状態: 提案 (設計素案 2026-08 の改訂版)
- 基準コード: `dev` (`2af3896`)
- 関連: [設計レビュー](./core-plugin-review.md) / [Tool Plugin Contract](../contracts/tool-plugin.md) / [ADR 0001](../decisions/0001-mcp-tool-contract.md) / [ADR 0002](../decisions/0002-plugin-directory-layout.md)

## 1. 目的

本プロジェクトを、コーディングエージェントが Issue 単位・限定コンテキストで安全に開発できる構造へ移行する。

1. `AGENTS.md` によるエージェント向け開発ルールの標準化
2. Core / Plugin の境界明確化
3. Plugin の単体開発・単体テストを可能にする
4. Tool Calling 機能を Plugin として追加可能にする
5. Issue ごとに作業範囲を限定し、コンテキスト消費と意図しない変更を抑える

**過度な抽象化・汎用フレームワーク化は目的としない。**

---

## 2. Core / Plugin の境界

### Core — Bot として成立するために必須

- Discord 接続・音声入出力
- STT
- Wake Word 検出
- `ZundamonSession` (会話システムのオーケストレーター)
- 会話状態管理
- Short-term Memory (会話コンテキスト管理の一部)
- LLM Client + プロバイダアダプタ
- TTS / VOICEVOX 連携
- **Tool Runtime / Plugin Registry**
- 設定・起動処理

### Plugin — 後から追加・削除できる「能力」

| Plugin | tool | 状態 |
|---|---|---|
| `long-term-memory` | `save_memory` / `search_memory` | 実装済み (`src/memory/`)。移行対象 |
| `web-search` | `web_search` | 実装済み (`src/webSearchTools.ts`, `src/search/`)。移行対象 |
| weather / discord-history / obs-screenshot | — | 将来。多くは外部 MCP サーバで賄える |

原則: **LLM へ新しい「能力」を与える Tool Calling 機能は Plugin 候補**。

Plugin を全て無効化しても Bot は会話可能であること。

### Adapter レイヤーは作らない

Discord は本プロジェクトの前提であり交換可能性の利得が小さい。OpenAI も `LLMClient` 抽象が既にあり、`baseURL` の差し替えで Ollama / vLLM を向ける余地がある。**3層化 (Core / Adapter / Plugin) は採用しない**が、将来の分離を妨げる設計にもしない。

---

## 3. 依存方向

```
Plugin  ──→  src/core/contracts/**
Core    ──✗→  具体的な Plugin 実装
Plugin  ──✗→  他の Plugin
```

Core は特定 Plugin の存在を前提としない。組み合わせるのは起動時の Composition Root だけ。

```
起動処理 (discordBot.ts)
   ├── Core を構築
   ├── Plugin を構築
   └── PluginRegistry へ登録 → ToolRuntime → LLMClient へ渡す
```

### 文書ではなく機械で強制する

`tsc` に import 境界の強制機能は無い。`dependency-cruiser` を CI で回す。

```
禁止: src/**        →  plugins/**
禁止: plugins/a/**  →  plugins/b/**
許可: plugins/**    →  src/core/contracts/** のみ
```

**これが依存ルールのうち唯一機械的に効く部分**であり、無ければ本節はエージェントがいずれ逸脱する慣習に留まる。

ただし import 境界では捕捉できない依存もある。`main` 時点の `zundamonSession.ts` が system prompt に `search_memory` を文字列で埋め込んでいたのがその例で、`dev` の `ToolConfig.instructions` により既に解消されている。**この種の依存を作らないこと自体を規約とする。**

---

## 4. Plugin の二層構成

| | 実体 | 呼び出しコスト | 用途 |
|---|---|---|---|
| **Tier 1 / in-process** | MCP 型に一致した素の TS オブジェクト | 関数呼び出しそのもの | 自作 Plugin (`long-term-memory`, `web-search`) |
| **Tier 2 / 外部 MCP** | stdio / Streamable HTTP 越しの JSON-RPC | 1〜5ms | 既製の MCP サーバ (weather, filesystem, …) |

両者は Registry 上で同一の `Tool` レコードになるため、**Core のコードパスは1本**。

MCP の *型* を採用することに実行時コストは無い。レイテンシが乗るのは Tier 2 のトランスポートだけで、そこは元々ネットワーク I/O を伴うツール (`web_search` の実測レンジは 500〜3000ms) に限られる。**レイテンシが問題になる場所と MCP のコストが乗る場所は重ならない。**

詳細は [ADR 0001](../decisions/0001-mcp-tool-contract.md)。

---

## 5. Tool Runtime の位置

```
LLM
 │ tool call
 ▼
LLMClient (プロバイダアダプタ + tool ループ)
 │ runtime.call(name, argsJson, caller, signal)
 ▼
ToolRuntime            ← 名前解決 / 引数検証 / timeout / エラー2系統 / ログ
 │
 ▼
PluginRegistry
 ├─ long-term-memory__save_memory
 ├─ long-term-memory__search_memory
 ├─ web-search__web_search
 └─ <外部 MCP サーバ>__<tool>
```

### ループは `OpenAILLMClient` から動かさない

tool ループは既に `src/llm/openaiClient.ts:63-176` にある。ストリーミングの delta 再構築 (`tool_calls` が chunk 間で分割される) と `finally` での `stream.controller.abort()` (課金トークンを止めるために必要) に強く絡んでおり、移設は高リスクで見返りが小さい。

代わりに `streamChat` の第3引数を `ToolConfig` → `ToolRuntime` へ差し替える。`openaiClient.ts:164` の1行が変わるだけで、共通処理が Runtime の1箇所に集まる。`mergeToolConfigs` (`src/llm/toolConfig.ts`) は Runtime の内部実装として発展させる。

---

## 6. レイテンシとターンテイキング

**リアルタイム音声ボットでは tool 実行時間はそのまま無音時間になる。** `web_search` の導入でこれは現実の問題になった。

- 各 tool が `_meta["zundamon/latencyClass"]` で `fast` / `normal` / `slow` を宣言する
- Runtime が級ごとの timeout 予算を `AbortSignal.any([caller, AbortSignal.timeout(budget)])` で強制する
- 閾値 (~800ms) 超過で Runtime がイベントを出し、session が繋ぎ発話できるようにする
- 未宣言および外部 MCP サーバ由来の tool は `slow` とみなす

現状 `SearchConfig.timeoutMs` はプロバイダ内部の HTTP timeout であって、セッション層は tool の所要時間を知らない。予算の強制は Core の責務とする (Plugin が `signal` を無視してもラウンドをハングさせないため)。

詳細は [Contract §7](../contracts/tool-plugin.md#7-レイテンシとキャンセル)。

---

## 7. ディレクトリ構成

```
/
├─ AGENTS.md
├─ CLAUDE.md                    → AGENTS.md への symlink
├─ docs/
│  ├─ architecture/  contracts/  decisions/  agent/
│
├─ src/
│  ├─ core/
│  │  ├─ contracts/{tool,plugin,runtime}.ts
│  │  ├─ pluginRegistry.ts
│  │  └─ toolRuntime.ts
│  ├─ discord/  llm/  session/  stt/  tts/
│  └─ config.ts  discordBot.ts  ...
│
└─ plugins/
   ├─ AGENTS.md
   ├─ CLAUDE.md                 → AGENTS.md への symlink
   ├─ long-term-memory/
   │  ├─ AGENTS.md  CLAUDE.md   (同上)
   │  ├─ index.ts  manifest.ts
   │  ├─ saveMemory.ts  searchMemory.ts
   │  ├─ longTermMemory.ts  embeddings.ts
   │  └─ test/
   └─ web-search/
      ├─ AGENTS.md  CLAUDE.md
      ├─ index.ts  manifest.ts
      ├─ providers/{searxng,openai,mock}.ts
      └─ test/
```

`src/core/` への全面移動はしない。**Plugin Contract など本当に共有される部分だけを Core として明示する。**

### 移動するもの

| 現在 | 移動先 |
|---|---|
| `src/memory/longTermMemory.ts`, `embeddings.ts`, `memoryTools.ts` | `plugins/long-term-memory/` |
| `src/webSearchTools.ts`, `src/search/**` | `plugins/web-search/` |
| `src/memory/shortTermMemory.ts` | `src/session/shortTermMemory.ts` (Core に残す。圧縮ポリシーは既に session 側) |

`tsconfig.json` は `noEmit: true` でビルド段階が無いため、ルート直下 `plugins/` のコストは `include` に1行足すだけ。詳細は [ADR 0002](../decisions/0002-plugin-directory-layout.md)。

---

## 8. AGENTS.md 階層

正規の指示書は `AGENTS.md`。Claude Code は `AGENTS.md` を読まないため、**各ディレクトリに `CLAUDE.md` symlink を置く**。

```bash
ln -s AGENTS.md CLAUDE.md    # 各コンポーネントディレクトリで
```

ルートだけは Claude 固有の追記ができるよう import 形式にする。

```markdown
@AGENTS.md

## Claude Code
（Claude 固有の指示があればここ）
```

### 前提条件

`.gitignore` の `CLAUDE.md` の行を**外す**必要がある (commit `5dc088c` で追加されている)。外さない限り本節は成立しない。

### ルート `AGENTS.md` の中身

詳細仕様書ではなく「目次 + 絶対ルール」。**200行以下**を目標とする。

- プロジェクト概要 / アーキテクチャ概要
- Core / Plugin 依存ルール
- Build / Test / Typecheck コマンド
- Issue 駆動開発ルール
- Safety Rules (最低限)
- 詳細ドキュメントへのリンク

### 詳細ドキュメントは `@import` しない

`CLAUDE.md` 内の `@docs/agent/safety.md` は**起動時に必ず全文がロードされる**ため、「関係する Issue のときだけ読ませる」が成立しない。パスはバッククォートで囲んで参照に留める (`` `docs/agent/safety.md` ``)。

Component 固有情報は Root へ集約せず、各コンポーネントの `AGENTS.md` に置く。`long-term-memory` の Issue を扱うエージェントが読むのは Root → `plugins/` → `long-term-memory/` の3階層だけで済む状態を目指す。

---

## 9. 実装順序

### Phase 0 — 検証基盤 【最優先】

これ無しでは以降の全変更が回帰を検出できない。

- `node:test` 導入、`npm test` で集約 (現在10本の `test:*` を個別に叩く状態)
- **`MockLLMClient` に tool 呼び出しをスクリプトできる機能を追加**
- `test/fakeOpenAIServer.ts` に tool_calls の SSE 応答を追加
- 現行 `save_memory` / `search_memory` / `web_search` の回帰テストを先に書く (改名前の安全網)
- GitHub Actions: `typecheck` + `test` (既存テストは全て API キー不要でオフライン実行可能)
- `dependency-cruiser` 導入と境界ルール
- `.gitignore` から `CLAUDE.md` を除去

### Phase 1 + 2 — Contract + Runtime 【垂直スライスとして一体で】

消費者ゼロで設計された契約は必ず間違うため、Phase 1 を単独で走らせない。

- `src/core/contracts/{tool,plugin,runtime}.ts`
- `PluginRegistry` + `ToolRuntime` (`mergeToolConfigs` を発展させる)
- `openaiClient.ts` の `ToolConfig` → `ToolRuntime` 差し替え
- 既存 `ToolConfig` からの互換アダプタ
- `inputSchema` による引数検証と timeout 予算を Runtime へ集約
- **Acceptance: 既製の外部 MCP サーバ1本が Core 無改造でマウントできること**

消費者は `long-term-memory` / `web-search` / 外部 MCP サーバの3つ。

### Phase 3 — Plugin 移行

- `VectorStore` / `Embedder` インターフェース抽出 (`SearchProvider` が既に手本になっている)
- `long-term-memory` / `web-search` を `plugins/` へ移動
- tool 名を prefix 化 (Phase 0 の回帰テストが守る)
- 合成ルートの統合 (`discordBot.ts` / `memorySessionDemo.ts` / `memoryToolCallTest.ts` / `memoryTest.ts` の4箇所)

### Phase 4 — Agent Harness

`AGENTS.md` / `CLAUDE.md` symlink / `docs/agent/*` / Issue template / label

### Phase 5 — Agent 自動化

`agent:ready` Issue → isolated worktree/branch → 実装 → テスト → PR

---

## 10. Issue 駆動開発

```
GitHub Issue → 人間レビュー → agent:ready → エージェント → 実装 → テスト → PR → 人間レビュー
```

エージェントが自ら無制限に Issue を選択する方式にはしない。`agent:ready` を明示的な承認境界とする。

### Issue Scope の記述

```markdown
## Scope
plugins/long-term-memory/**

## Allowed dependencies
src/core/contracts/**

## Do not modify
src/session/**
plugins/* (long-term-memory 以外)

## Contract
docs/contracts/tool-plugin.md

## Acceptance Criteria
- save_memory が動作する
- search_memory が動作する
- Discord 無しでテストできる
- LLM 無しでテストできる

## Test
npm test -- --test-name-pattern "long-term-memory"
```

### ラベル

`component:core` / `component:plugin-memory` / `component:plugin-search` / `component:discord` / `component:stt` / `component:tts`
`agent:ready` / `agent:blocked`
`risk:low` / `risk:high`

### Contract 変更ルール

**Plugin 開発 Issue では Core Contract を原則変更しない。** 不足が判明したら、勝手に変更するのではなく提案 → 人間レビュー → 別 Issue または Scope 変更とする。**これをエージェントによる変更範囲拡大を防ぐ重要な Safety Boundary とする。**

Contract を変更する場合は全 Plugin のテストを実行する。

---

## 11. 設計原則

**YAGNI** — 将来必要になるかもしれない交換可能性だけを理由に抽象化しない。Discord Adapter 等は必要になった時点で分離する。

**Explicit Boundaries** — Core / Plugin 境界は人間向け文書だけでなく、import 境界と Contract として表現し、CI で強制する。

**Local Context** — エージェントがリポジトリ全体を理解しなくても担当コンポーネントを変更できる構造にする。

**Contract First** — Plugin 同士を直接結合させず、安定した Core Contract を介して接続する。

**Standard over Bespoke** — 独自規格を作らず、既に業界が合意している標準 (MCP、JSON Schema) に構造を合わせる。導入容易性とメンテナンス性の両方が上がる。

**Human-Gated Autonomy** — 作業開始・Scope 拡大・Contract 変更など重要な境界では人間の承認を要求する。

---

## 12. 最終目標

```
Issue を作る → 対象 Plugin を指定 → 人間がレビューして agent:ready
  → エージェントは対象 Plugin + Contract だけ読む
  → Plugin を単体実装・テスト → PR → 人間がレビュー
```

**Core は安定させ、能力は Plugin として増やす。** この構造を、エージェントによる継続的な開発の Safety Boundary として利用する。
