# ずんだもんボット PoC — ウェイクワード判定ロジック

音声認識(STT)・VOICEVOX・Discordはまだ繋がっていない、
「ウェイクワード検知後のLLM呼び出しタイミング」だけを検証する最小構成。

## セットアップ

```bash
npm install
cp .env.example .env
# .env に OPENAI_API_KEY を設定
```

## 実行方法

### 1. モックLLMでロジック検証（API課金なし）

```bash
npm run scenarios
```

5パターンのシナリオ（文頭型・文末型・単独+間・無関係な追加発話・
関連する追加発話によるグレースフル中断）を自動実行してログを見る。

### 2. 実際のOpenAI APIでCLI対話

```bash
npm run cli
```

キーボード入力を「VAD final確定テキスト」に見立てて動かす。
1行入力 → 応答生成中に**すぐ次の行を入力**すると「追加発話」として
扱われる（実際の音声だとここが「猶予ウィンドウ中の後続発話」に相当）。

例:
```
> ずんだもん、明日の天気は？
[一次応答] はい
(state -> AWAKENED)
(state -> PROCESSING)
[文完成→VOICEVOXキュー] 天気は...   <- ここで割り込む
> やっぱいいや、遠足の話がしたい
  [判定] "やっぱいいや、遠足の話がしたい" -> continuation=true (...)
[中断要求] 第2ラウンドの発話により中断要求（現在の文は言い切らせる）
[文完成→VOICEVOXキュー] (今組み立て中の文はここで完成させて止める)
(state -> PROCESSING)
[文完成→VOICEVOXキュー] 遠足について...
[最終応答確定] ...
```

## 設計の要点

- **先行投機実行**: ウェイクワード検知後、猶予ウィンドウで「待つ」のではなく
  即座に本体LLMへ投げる。並行して2秒間の猶予ウィンドウを開く。
- **関連性判定**: 猶予ウィンドウ中に追加発話が来たら、軽量モデル
  (judgeModel、想定はGPT-5.6 Luna等)で「呼びかけの続きか無関係な発話か」
  を判定する。無関係なら何もせず、続きなら中断要求を出す。
- **文単位グレースフル中断**: 中断要求が出ても即座にストリームを切らない。
  現在組み立て中の文（句点区切り）が完成するのを待ってから、残りの文を
  破棄して次のラウンドへ移る。音声として不自然な切れ方を避けるため。

## ファイル構成

```
src/
  llm/
    types.ts          LLMクライアントの抽象インターフェース
    mockClient.ts      APIを叩かないモック実装（レイテンシ模擬つき）
    openaiClient.ts     OpenAI(GPT-5.6 Sol / Luna)実装
  session/
    types.ts            Utterance, SessionState, SessionEvents の型
    wakeword.ts          ウェイクワード検知
    sentenceBuffer.ts    文単位ストリームバッファ（グレースフル中断の要）
    zundamonSession.ts   セッション管理コアロジック（本体）
  scenarios.ts          モックLLMでの自動シナリオテスト
  cli.ts                実OpenAI APIでの対話的CLI検証
```

## 未実装・次のステップ

- STT層（hayamimi/sherpa-onnx-node）との接続 — 現状はキーボード入力で代用
- VOICEVOX層との接続 — `onSentenceReady` イベントを実際の音声合成キューに
  つなぎ込む
- discord.js（`@discordjs/voice`）との接続 — ボイスチャンネル音声受信・
  ストリーム再生
- モデル名は暫定（`gpt-5.6-sol` / `gpt-5.6-luna`）。実際のAPI呼び出しで
  エラーになる場合は正式なモデル名に置き換える
- 話者複数対応: 現状 `ZundamonSession` は1話者分の想定。実運用では
  話者(speakerId)ごとにセッションを分けるか、共有会話ログの扱いを別途設計する
- 判定コストの最適化: `judgeContinuation` は追加発話のたびにAPI呼び出しが
  発生する。呼びかけ語のみの単純なケースはローカルヒューリスティックで
  先に弾く等の最適化余地あり
