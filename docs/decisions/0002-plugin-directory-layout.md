# ADR 0002: Plugin をリポジトリルート直下の `plugins/` に置く

- 状態: 提案
- 日付: 2026-08
- 関連: [Core / Plugin アーキテクチャ](../architecture/core-plugin.md)

## 文脈

Plugin 実装の置き場所を `src/plugins/` とルート直下 `plugins/` のどちらにするか、設計素案の未決事項として残っていた。

現状 (`dev`) では tool 実装の置き場所が既に割れている。

| tool 群 | 実装の場所 |
|---|---|
| memory | `src/memory/memoryTools.ts` (サブディレクトリ) |
| web search | `src/webSearchTools.ts` (**`src/` 直下**) + `src/search/` |

`src/` 直下は既に20本のデモ / プローブスクリプトで混雑しており、全ソース LOC の41%を占める。Plugin 実装がそこに混ざると、エージェントから見て「どこまでが Core か」が読み取れなくなる。

関連する現状の制約:

- `tsconfig.json` は `noEmit: true`。ビルド段階が無く `tsx` で TypeScript を直接実行する
- `include` は `["src/**/*.ts", "test/**/*.ts"]`
- `paths` エイリアスは無い。全ての相対 import が `.js` 拡張子付き (`moduleResolution: "bundler"` だが実行は ESM のため必須)
- TypeScript は `^7.0.2`

## 決定

**ルート直下の `plugins/` に置く。**

```json
"include": ["src/**/*.ts", "test/**/*.ts", "plugins/**/*.ts"]
```

各 Plugin は自身のディレクトリに `AGENTS.md` / `CLAUDE.md` (symlink) / 実装 / `test/` を持つ。

```
plugins/
├─ AGENTS.md
├─ CLAUDE.md          → AGENTS.md
├─ long-term-memory/
│  ├─ AGENTS.md  CLAUDE.md
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

## 理由

### 1. ビルド設定上のコストがほぼゼロ

`noEmit: true` でビルド段階が無いため、`rootDir` / `outDir` の整合を気にする必要がない。通常 monorepo でルート直下にソースを増やす際に発生する出力パスの再編は起きず、**コストは `include` に1行足すだけ**である。

これが `src/plugins/` を選ぶ最大の理由 (設定変更を避ける) を消す。

### 2. 境界がエージェントから見て一目瞭然になる

`src/` の中にあると、`src/session/` や `src/llm/` と同列の1ディレクトリに見える。ルート直下にあれば、Issue Scope に `plugins/long-term-memory/**` と書いたときの「触ってよい範囲」が視覚的に明確になる。

エージェントがリポジトリ全体を探索せずに担当コンポーネントを変更できる構造にする、という目的に直接効く。

### 3. `dependency-cruiser` のルールが素直に書ける

```
禁止: src/**        →  plugins/**
禁止: plugins/a/**  →  plugins/b/**
許可: plugins/**    →  src/core/contracts/** のみ
```

`src/plugins/` だと1つ目のルールが「`src/**` (ただし `src/plugins/**` を除く) → `src/plugins/**`」という除外付きの表現になり、規則が読みにくくなる。

### 4. `src/` 直下の混雑を悪化させない

現在の `src/webSearchTools.ts` の位置は、Plugin 実装が Core のエントリポイントと同じ階層に置かれている状態である。この乖離は Plugin が増えるほど広がる。

## 結果

### 得られるもの

- Core と Plugin の物理的な境界が明確になる
- Issue Scope の記述がディレクトリと1対1で対応する
- 各 Plugin が自身のテストとエージェント指示書を同居させられる
- `src/` 直下の混雑がこれ以上増えない

### 支払うもの

- `tsconfig.json` の `include` に1行追加
- `plugins/` から Core を参照する相対パスが深くなる (`../../src/core/contracts/tool.js`)。`paths` エイリアスは導入しない — 現在エイリアスがゼロであり、`tsx` / ESM の解決との整合を確認する手間に見合わない
- 既存ファイルの移動が発生する (`src/memory/`, `src/webSearchTools.ts`, `src/search/`)。Phase 3 で実施する

### 規約

- **新規ファイルでも相対 import の `.js` 拡張子は必須。** `moduleResolution: "bundler"` だが実行時は tsx/ESM のため、拡張子を省くと実行時に解決できない
- Plugin id はディレクトリ名と一致させる (`plugins/long-term-memory/` ↔ `manifest.id === "long-term-memory"`)
- Plugin のテストは `plugins/<id>/test/` に置き、`npm test -- --test-name-pattern "<id>"` で絞り込めるようテスト名に Plugin id を含める

## 検討して採用しなかった案

### 案 A: `src/plugins/`

`include` の変更が不要という利点があるが、`noEmit: true` のためその利点が小さい。境界の可視性と `dependency-cruiser` ルールの素直さで劣る。

### 案 B: 完全な monorepo 化 (npm workspaces + package ごとの tsconfig)

Plugin ごとに独立した依存関係とビルドを持てるが、現在の「ビルド無し・単一 tsconfig・`tsx` 直接実行」という構成を大きく壊す。素案が明示的に「過度な monorepo 化は行わない」としており、得られる分離に対してコストが見合わない。

### 案 C: 現状維持 (`src/` 直下と `src/memory/` の混在)

置き場所の規約が無いまま Plugin が増えると、エージェントが新規 Plugin をどこに置くか判断できず、レビューのたびに指摘が発生する。
