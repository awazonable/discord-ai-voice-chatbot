# ずんだもんボット PoC — ウェイクワード判定ロジック

音声認識(STT)・VOICEVOX・Discordはまだ繋がっていない、
「ウェイクワード検知後のLLM呼び出しタイミング」だけを検証する最小構成。

## セットアップ

```bash
npm install
cp .env.example .env
# .env に OPENAI_API_KEY を設定
```

長期記憶(`memory:*`)を使う場合はローカルQdrantも起動しておくこと
（Windowsの場合、[GitHub Releases](https://github.com/qdrant/qdrant/releases)
の`qdrant-x86_64-pc-windows-msvc.zip`を展開して`qdrant.exe`を実行するか、
`docker run -p 6333:6333 qdrant/qdrant`）。既定では`http://127.0.0.1:6333`
に接続する。

STT(`stt:*`)を使う場合はモデルを`.models/`に置く（gitignore済み、初回のみ）:

```bash
mkdir -p .models && cd .models
gh release download asr-models -R k2-fsa/sherpa-onnx \
  -p "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01.tar.bz2" -O reazonspeech.tar.bz2
tar -xjf reazonspeech.tar.bz2 && rm reazonspeech.tar.bz2
gh release download asr-models -R k2-fsa/sherpa-onnx -p "silero_vad_v5.onnx"
```

## 実行方法

コマンドは「APIを叩かないもの」→「実APIを叩くもの」の順に並べてある。
**まず `preflight` を通してから `scenarios:real` を叩くこと。**
モデル名が違うまま本番に投げるのを防げる。

| コマンド | APIキー | 課金 | 用途 |
|---|---|---|---|
| `npm run scenarios` | 不要 | なし | モックLLMでロジックだけ検証 |
| `npm run test:fake` | 不要 | なし | **OpenAI SDK・SSE・中断まで含めた実コード経路**をローカルのフェイクサーバで検証 |
| `npm run typecheck` | 不要 | なし | 型チェック |
| `npm run preflight` | 必要 | ごく少 | 認証・モデル名の実在確認・レイテンシ実測 |
| `npm run scenarios:real` | 必要 | 少 | 実APIで4シナリオを自動実行 |
| `npm run cli` | 必要 | 少 | 実APIで対話的に検証 |
| `npm run toolcall` | 必要 | ごく少 | ツールコール(function calling)が動くかの単発疎通確認 |
| `npm run tts:test` | 必要(SUSHIKI_API_KEY) | 少 | 音声合成(su-shiki VOICEVOX API)の単発疎通確認。output/にwavを保存 |
| `npm run tts:playback-demo` | 必要(両方) | 中 | onSentenceReadyを実際の合成+スピーカー再生につなぎ込んで実測 |
| `npm run test:tts-fake` | 不要 | なし | TTSクライアントの異常系(HTTP500・不正JSON等)をフェイクサーバで検証 |
| `npm run tts:overhead-test` | 必要(SUSHIKI_API_KEY) | 少(合成1回のみ) | 再生方式ごとのオーバーヘッドをWAV実長と比較 |
| `npm run memory:test` | 必要+Qdrant | ごく少 | 長期記憶(Qdrant)の保存・意味検索の単発疎通確認 |
| `npm run memory:toolcall-test` | 必要+Qdrant | 少 | save_memory/search_memoryをLLMのツール呼び出し経由で実行 |
| `npm run memory:session-demo` | 必要+Qdrant | 中 | 短期記憶の自動圧縮+長期記憶の想起を実セッションで確認 |
| `npm run stt:test` | 不要 | なし | STT(ReazonSpeech Zipformer)の疎通確認。同梱テスト音声+TTS閉ループ |
| `npm run stt:stream-test` | 必要(TTS用) | ごく少 | VAD+STTのストリーミング疑似投入テスト |
| `npm run discord:test` | 必要(Discord+TTS) | 少 | Discord接続・ボイスチャンネル参加・音声再生・テキスト報告の疎通確認 |

### 1. モックLLMでロジック検証（API課金なし）

```bash
npm run scenarios
```

無関係な追加発話が無視されるケースと、関連する追加発話による
グレースフル中断のケースを自動実行してログを見る。

### 2. 実コード経路の検証（APIキー不要・課金なし）

```bash
npm run test:fake
```

`npm run scenarios` のモックはSDKを通らないため、**実API固有の経路
（openai SDKのSSEパース・`finish_reason`・AbortSignalによる切断）は
検証できない**。`test:fake` はローカルにOpenAI互換のフェイクサーバを立て、
`scenarios:real` とまったく同じ `OpenAILLMClient` / シナリオ実装を
そこに向けて実行する。HTTP越しなので実APIとの差分はモデルの中身だけ。

サーバ側から「中断要求時に本当にHTTP接続が切れているか」
（＝破棄した応答のトークンを受信し続けていないか）も検証する。

### 3. プリフライト（実APIを叩く前に必ず）

```bash
npm run preflight
```

- 認証が通るか
- `/v1/models` を取得し、**`.env` のモデル名がそのキーで実在するか**を照合
  （実在しなければ候補一覧を出して終了。本番投入前に止まる）
- `streamChat` の**初トークンまでのレイテンシを実測**
  （猶予ウィンドウ2秒を超えていれば警告する。後述）
- `judgeContinuation` がJSONモードで正しく返るか

> PoCの既定モデル名 `gpt-5.6-sol` / `gpt-5.6-luna` は**設計時の仮称**であり、
> そのままでは通らない可能性が高い。preflight が出す候補一覧から
> 実在するモデル名を選んで `.env` を書き換えること。

### 4. 実APIでのシナリオ自動実行

```bash
npm run scenarios:real
```

`cli` の手入力だと「ストリーミング中に割り込む」タイミングが打鍵速度に
依存して再現しない。このランナーは固定sleepではなく**「N文目が完成した
瞬間」をトリガに追加発話を注入する**ため、応答速度が変わっても狙った
経路を通せる。

| シナリオ | 検証内容 | 期待経路 |
|---|---|---|
| S1 | 追加発話なし。喋り切って IDLE に戻る | — |
| S2 | 無関係な追加発話は中断を起こさない | `ignored` |
| S3 | 長い応答の途中の関連発話 → 文を言い切ってから次ラウンド | `interrupt` |
| S4 | 応答完了後に判定が返るケースで発話が握り潰されない | `newRound` |

### 5. 実APIで対話的に検証

```bash
npm run cli
```

キーボード入力を「VAD final確定テキスト」に見立てて動かす。
1行入力 → 応答生成中に**すぐ次の行を入力**すると「追加発話」として
扱われる（実際の音声だとここが「猶予ウィンドウ中の後続発話」に相当）。

## 設計の要点

- **先行投機実行**: ウェイクワード検知後、猶予ウィンドウで「待つ」のではなく
  即座に本体LLMへ投げる。並行して2秒間の猶予ウィンドウを開く。
- **関連性判定**: 猶予ウィンドウ中に追加発話が来たら、軽量モデル
  (judgeModel)で「呼びかけの続きか無関係な発話か」を判定する。
  無関係なら何もせず、続きなら中断要求を出す。
- **文単位グレースフル中断**: 中断要求が出ても即座にストリームを切らない。
  現在組み立て中の文（句点区切り）が完成するのを待ってから、残りの文を
  破棄して次のラウンドへ移る。音声として不自然な切れ方を避けるため。

### 追加発話が通る2つの経路（実API検証で判明）

追加発話の扱いは、**判定LLMの往復時間と本体応答の残り長さの大小**で
2つに分岐する。どちらも正常動作であり、シナリオ側で期待経路を明示している。

```
判定が返った時点で……
  まだ喋っている  → interrupt : 文を言い切ってから破棄し、次ラウンドへ
  もう喋り終わった → newRound  : 中断するものが無いので、そのまま次ラウンド
```

重要なのは、**判定往復（実測で数百ms〜数秒）が短い応答の全長を上回るのは
珍しくない**という点。システムプロンプトが「短く簡潔に」と指示している
ぶん応答が短くなるため、実運用ではグレースフル中断より `newRound` 経路の
ほうが多く通る可能性が高い。グレースフル中断は長い応答でのみ効く。

## ファイル構成

```
src/
  config.ts             .env の読み込みと構成の表示（課金事故の予防）
  llm/
    types.ts            LLMクライアントの抽象インターフェース
    errors.ts           中断エラーの判定（SDKごとの差異を吸収）
    mockClient.ts       APIを叩かないモック実装（レイテンシ模擬つき）
    openaiClient.ts     OpenAI(互換)実装
    callLogger.ts        LLM呼び出し（本体・判定）の入出力を logs/llm-calls.jsonl
                          に1行JSONで記録する仮ロガー
  session/
    types.ts            Utterance, SessionState, SessionEvents の型
    wakeword.ts         ウェイクワード検知
    sentenceBuffer.ts   文単位ストリームバッファ（グレースフル中断の要）
    audioClock.ts        テキスト生成と音声再生のズレを追跡する仮クロック
                          （0.1秒/文字の概算。VOICEVOX未接続の間のプレースホルダー）
    zundamonSession.ts  セッション管理コアロジック（本体）
  tts/
    types.ts             TTSクライアントの抽象インターフェース
    sushikiClient.ts      su-shiki(Web版VOICEVOX API)実装
    localVoicevoxClient.ts ローカルVOICEVOXエンジン(REST API)実装
    createTTSClient.ts     .envの設定からどちらを使うか選ぶ
                          (VOICEVOX_BASE_URL優先、無ければsu-shiki)
    playback.ts           WAVをホストスピーカーで再生(Windows専用)。
                          PersistentPowerShellPlayer(プロセス使い回し、既定)と
                          playWavFile(毎回新規起動、単発確認用)の2実装
    playbackQueue.ts       onSentenceReadyから渡された文を順番に合成→再生する実キュー
    wav.ts                 WAVヘッダから実際の音声長(ms)を読み取る
  memory/
    embeddings.ts         OpenAI埋め込みAPIのラッパー
    longTermMemory.ts      Qdrant(ベクトルDB)への保存・検索
    memoryTools.ts          save_memory/search_memoryのツール定義
    shortTermMemory.ts      短期記憶(要約+重要な事実)のデータ保持・描画
  memoryTest.ts            長期記憶(Qdrant)単体の疎通テスト
  memoryToolCallTest.ts    save_memory/search_memoryをツール呼び出しで検証
  memorySessionDemo.ts     短期記憶の圧縮+長期記憶の想起を実セッションで確認
  stt/
    sttEngine.ts            VAD(Silero)による発話区間検出+オフライン認識(ReazonSpeech)
  sttTest.ts               STT単体の疎通テスト(同梱テスト音声+TTS閉ループ)
  sttStreamTest.ts          VAD+STTのストリーミング疑似投入テスト
  discordTest.ts            Discord接続・ボイスチャンネル参加・音声再生の疎通テスト
  scenarios.ts          モックLLMでの自動シナリオテスト
  scenarioRunner.ts     シナリオ定義と実行（real / fake で共用）
  realScenarios.ts      実APIでのシナリオ実行エントリ
  preflight.ts          実API疎通・モデル名検証・レイテンシ実測
  cli.ts                実APIでの対話的CLI検証
  ttsTest.ts              音声合成の単発疎通テスト（話者一覧取得+短文合成）
  ttsPlaybackDemo.ts       onSentenceReadyを実際の再生につなぎ込むデモ
  ttsOverheadTest.ts       再生方式ごとのオーバーヘッド比較(WAV実長との突き合わせ)
test/
  fakeOpenAIServer.ts   OpenAI互換の最小フェイクサーバ（SSE・中断検知つき）
  runAgainstFake.ts     フェイクサーバに対する統合テスト
  serveFake.ts          フェイクサーバの単体起動（preflightの動作確認用）
  fakeTTSServer.ts        su-shiki互換の最小フェイクサーバ（異常系検証用）
  runTTSErrorTests.ts     SushikiTTSClientの異常系テスト
```

### APIキー無しで preflight / scenarios:real を試す

```bash
npx tsx test/serveFake.ts          # 別ターミナルで起動
OPENAI_API_KEY=dummy OPENAI_BASE_URL=http://127.0.0.1:8787/v1 \
  MAIN_MODEL=fake-main JUDGE_MODEL=fake-judge npm run preflight
```

## 引き継ぎ

実APIでの実測はまだ未達（テスト作成環境にAPIキーが無かったため）。
現状・再開手順・実測後に決めたい設計判断は
[`docs/openai-test-handoff.md`](docs/openai-test-handoff.md) に集約してある。

## LLM呼び出しログ

実API/フェイクサーバ問わず、`OpenAILLMClient` を使う実行は
`logs/llm-calls.jsonl`（gitignore済み）に本体モデル・判定モデルそれぞれの
入力（messages）と出力（応答テキスト・判定結果）を1呼び出し1行のJSONで
追記する。何を送って何が返ってきたかを後から確認したいとき用。

```bash
# 直近の判定呼び出しだけ見る例
grep '"kind":"judge"' logs/llm-calls.jsonl | tail -5
```

## 未実装・次のステップ

- STT層（sherpa-onnx-node）との接続 — 現状はキーボード入力で代用
- VOICEVOX層との接続: `tts/sushikiClient.ts` で音声合成そのものの疎通は
  取れた（`npm run tts:test`）。まだ `onSentenceReady` イベントには
  つなぎ込んでいない。つなぎ込む際は「テキスト生成が音声再生より速い」
  という `audioClock.ts` の前提（実測ベースの0.1秒/文字）を、実際の
  合成+再生時間の実測値に差し替えること
- discord.js（`@discordjs/voice`）との接続 — ボイスチャンネル音声受信・
  ストリーム再生
- モデル名の確定（`npm run preflight` で実在確認すること）
- 話者複数対応: 現状 `ZundamonSession` は1話者分の想定。実運用では
  話者(speakerId)ごとにセッションを分けるか、共有会話ログの扱いを別途設計する
- 判定コストの最適化: `judgeContinuation` は追加発話のたびにAPI呼び出しが
  発生する。呼びかけ語のみの単純なケースはローカルヒューリスティックで
  先に弾く等の最適化余地あり
- 判定LLMの誤判定対策: 実測で、無関係な発話を継続と誤判定するケースを
  確認した（詳細は [`docs/openai-test-handoff.md`](docs/openai-test-handoff.md)）。
  プロンプト調整や誤判定率の計測が必要
- 音声再生時間の考慮: `audioClock.ts` は文字数からの概算（0.1秒/文字）の
  仮実装。VOICEVOX接続後は実測の合成+再生時間に差し替えること
- **`GRACE_WINDOW_MS` が実質機能していない**: 猶予タイマーは張られるものの、
  追加発話は PROCESSING 中ならいつでも判定にかけられており、
  2秒の窓が何かをゲートしているわけではない。意図どおりに窓で絞るのか、
  それとも「応答中はいつでも割り込める」を正とするのか要決定（挙動を
  変える判断になるため本PoCでは既存挙動のまま据え置いている）。
