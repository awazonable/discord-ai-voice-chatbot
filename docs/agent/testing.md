# テスト戦略

エージェントによる継続的な変更を安全に受け入れるため、**機械的に検証可能なテストを Safety Boundary として扱う。**

- 関連: [Core / Plugin アーキテクチャ](../architecture/core-plugin.md) / [Tool Plugin Contract](../contracts/tool-plugin.md) / [Safety Rules](./safety.md)

---

## 1. 基本方針

- 新規 Core 機能・Plugin には原則として自動テストを追加する
- 外部サービスへ実接続しない Mock / Unit Test を優先する
- Plugin は単体でテスト可能な構造とする
- バグ修正時は、可能な限り再現テストを先に追加する
- PR では最低限の自動テストを必須とする
- **CI で再現可能なテストを基準とし、手動確認のみを Acceptance Criteria としない**

---

## 2. 現状と移行

### 現状 (`dev`)

| | 状態 |
|---|---|
| テストフレームワーク | 無し。`main()` が例外を投げ `process.exitCode = 1` する手書きスクリプト |
| アサーション | 混在。新しい `test/searchTools.test.ts` 等は `node:assert/strict` を使用 |
| 集約コマンド | **無し。** `test:*` が10本あり個別に叩く必要がある |
| CI | **無し。** `.github/` 自体が存在しない |
| Linter | 無し |
| ファイル命名 | `*.test.ts` / `test*.ts` / `run*.ts` が混在 |

### 移行 (Phase 0)

**`node:test` を採用する。** 新規依存ゼロで、Node 22 標準のテストランナーを使う。

```json
{
  "scripts": {
    "test": "node --import tsx --test",
    "typecheck": "tsc --noEmit"
  }
}
```

- 既存の8本のオフラインテストを `node:test` の `describe` / `it` へ移行する
- ファイル名は `*.test.ts` に統一する
- **Plugin 単位の実行**: `npm test -- --test-name-pattern "long-term-memory"`
- そのため、Plugin のテスト名には Plugin id を含めること

### Phase 0 の最優先項目

**`MockLLMClient` に tool 呼び出しをスクリプトできる機能を追加する。**

現在 `MockLLMClient` は `tools` 引数を捨てているため (`src/llm/mockClient.ts`)、「モデルが tool 呼び出しを選ぶ → `openaiClient` のループ → `onCall` → 結果を会話へ積んで継続」という経路が**一度も自動検証されていない**。この状態では Contract 変更・tool 名の prefix 化・結果形式の変更のいずれも回帰を検出できない。

併せて `test/fakeOpenAIServer.ts` に tool_calls の SSE 応答を追加する (ストリーミング中に `tool_calls` が chunk 間で分割される挙動を再現できるため、`openaiClient.ts` の delta 再構築の検証に必要)。

---

## 3. テスト階層

### 階層1: Unit Test

個々の関数・クラス・Plugin。外部 I/O は Mock 化。高速に実行可能。

例: `src/session/wakeword.ts` の判定、`src/search/types.ts` の `clampMaxResults` / `isHttpUrl`、Plugin の `execute()`。

### 階層2: Component / Integration Test

- `ZundamonSession` + Mock LLM
- `ToolRuntime` + Mock Plugin
- `PluginRegistry` + Plugin
- Discord / OpenAI / Qdrant / SearXNG は Fake または Mock

既存の `test/searchTools.test.ts` (`mergeToolConfigs` の合成・重複拒否・dispatch を検証) と `test/runAgainstFake.ts` (`fakeOpenAIServer` に対する実行) がこの階層に該当する。

**Phase 0 完了後に追加すべきもの**: Mock LLM に tool 呼び出しをスクリプトさせ、tool 結果が会話へ積まれて次のラウンドが継続することを検証するテスト。

### 階層3: E2E / Real Integration Test

Discord / OpenAI / VOICEVOX / Qdrant / SearXNG など実サービスへ接続するもの。

**CI の必須条件には含めない。** 手動または専用 workflow で実行する。該当する npm script は `README.md` の分類表を参照 (`scenarios:real`, `toolcall`, `memory:*`, `search:smoke`, `stt:*`, `tts:test`, `discord:*`)。

---

## 4. Plugin のテスト要件

Contract がテスト容易性を強制する形になっている。

- **`PluginContext` のモックだけで初期化できる** — Discord / LLM / VOICEVOX を起動しない
- **外部依存を `PluginContext` 経由で注入する** — グローバルや直接 import で具象を取らない
- **時刻は `ctx.now()` から取る** — `Date.now()` を直接呼ばない
- **`ctx.signal` の中断に応答する**
- **外部サービスへの通信部分をインターフェースとして切り出す**

最後の点は `src/search/types.ts` の `SearchProvider` が既に手本になっている。

```ts
export interface SearchProvider {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
}
```

`MockSearchProvider` により、SearXNG も OpenAI も起動せずに `web_search` tool を検証できる。**`LongTermMemory` は未対応** (`QdrantClient` を直接 new し、`EmbeddingClient` を値として import している) ため、Phase 3 で `VectorStore` / `Embedder` を同じ形に切り出す。

### 目標状態

`long-term-memory` Plugin が Discord / `ZundamonSession` / OpenAI / VOICEVOX / Qdrant を一切起動せずにテストできること。

---

## 5. PR 必須チェック

### 導入する順序

Phase 0 で以下を GitHub Actions に載せる。

```
typecheck        tsc --noEmit
unit-test        npm test
```

Phase 1 以降で追加する。

```
lint                 (linter 導入後)
architecture-check   dependency-cruiser による import 境界検証
```

`plugin-test` は `npm test` に含まれるため独立したジョブにはしない。

### `architecture-check` の内容

```
禁止: src/**        →  plugins/**
禁止: plugins/a/**  →  plugins/b/**
許可: plugins/**    →  src/core/contracts/** のみ
```

**依存ルールのうち機械的に効くのはここだけ**であり、これが無ければ依存方向はエージェントがいずれ逸脱する慣習に留まる。

### 分離するもの

外部 API キーや Discord 接続を必要とするテストは**通常の PR 必須チェックから分離する**。専用 workflow または手動実行とし、必要なら `workflow_dispatch` で起動できるようにする。

---

## 6. スキーマとリスクの機械的検証

Plugin の品質を人間の注意力に依存させないため、Registry の登録時に検証する。

- **`assertPortableSchema()`** — `inputSchema` が可搬サブセットに従っているか ([Contract §4](../contracts/tool-plugin.md#4-可搬-json-schema-サブセット))
- **tool 名の検証** — 公開名が `^[a-zA-Z0-9_-]{1,64}$` に収まるか、衝突していないか
- **`annotations` の存在** — 未宣言なら最も悲観的な既定を適用しつつ警告する

これらは起動時に失敗させ、テストからも直接呼べるようにする。

> 現状 `web_search` は `additionalProperties: false` を持つが memory 側は持たず、規約が既に食い違っている。どちらも OpenAI の `strict: true` では通らない。人間の注意力だけで規約を維持している状態であり、Plugin をエージェントが書き始めれば乖離は広がる。

---

## 7. Agent 開発ルール

エージェントが Issue を実装する場合の基本ルール。

- **既存テストを壊さない**
- **テストを skip / 無効化 / 削除して緑にしない**
- 新しい挙動には対応するテストを追加する
- バグ修正には可能な限り Regression Test を追加する
- PR 前に Issue Scope に対応するテストを実行する
- **Core Contract 変更時は関連する全 Plugin のテストを実行する** (`npm test` の全体実行)

### 「flake だから」で片付けない

テストが落ちた場合、まず原因を特定する。再実行で通ったことは原因の説明にならない。タイミング依存が疑われる場合は、そのテストを決定的にする修正を Scope 内で行えるか検討し、できなければ Issue のコメントで報告する。

### 既存のポーリングヘルパー

`waitForIdle` のような `setTimeout` ポーリングが複数のテストファイルに重複している。新しいテストを書く際は共通化を検討すること (ただし Issue Scope を超える場合は提案に留める)。
