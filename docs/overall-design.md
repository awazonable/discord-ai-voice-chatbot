# ずんだもんボット 全体設計

## 方針

- 言語は **Node.js / TypeScript に統一**（他アプリも同スタックで作り込む前提）
- 各コンポーネント（STTモデル・LLM・DB）は**差し替え可能な疎結合設計**にする

## 全体構成

```
Discordボイスチャンネル
  │
  ├─ discord.js + @discordjs/voice で音声受信（VoiceReceiver、ユーザー別PCM）
  │
  ▼
STT層（sherpa-onnx-node を直接使用。hayamimiは経由しない）
  │  hayamimi(oboroge0)はReazonSpeech Zipformer等の既存モデルをsherpa-onnx
  │  経由で呼び分けているだけで、モデル自体の独自性はない。
  │  同じモデルをNode.jsから直接叩けるため、言語ルーティングだけ自前実装する。
  │
  ▼
呼びかけ検知・ラウンド管理層（本PoCの中心部分）
  │  先行投機実行 + 猶予ウィンドウ + 関連性判定 + 文単位グレースフル中断
  │
  ▼
本体LLM層
  │  初期: OpenAI GPT-5.6 Sol（Responses/Chat Completions API、function calling）
  │  将来: ローカル Qwen3.6-35B-A3B（vLLM等でOpenAI互換API化、SDK差し替えのみ）
  │  ツール: ブラウザ検索、DB保存(記憶)、OBSスクショ取得、Discordチャット閲覧・履歴検索
  │
  ▼
記憶(DB)層
  │  全ログ保存ではなく、AIが必要と判断したものだけ保存
  │  返答後に「これ覚えておく？」を自己判定するハーネスを挟む
  │
  ▼
VOICEVOX合成 → discord.js VoiceConnection でDiscordへストリーム再生
```

## 各層の決定事項

### 入力層
- 音声: discord.jsの`@discordjs/voice`公式APIで受信（`VoiceReceiver`）
  - 素のdiscord.py（Python）には音声受信APIが存在しない。discord.jsは公式に
    `receiver.subscribe(userId)`でユーザーごとのOpus/PCMストリームを取得できる
- 画面情報: Discordを経由しない。**人間がOBSでDiscordアプリ画面を手動キャプチャ**し、
  そのOBSを`obs-websocket-js`でアプリから操作してスクショ取得
  - BotがDiscordの画面共有(Go Live)を受信するAPIはDiscord公式には存在せず、
    非公式手段はToS違反になるため採用しない

### STT層
→ 別紙 `stt-design.md` 参照。sherpa-onnx-node + ReazonSpeech Zipformer +
Silero VADのローカル疎通は確認済み（`npm run stt:test` / `stt:stream-test`）。
配布されているReazonSpeechモデルはオフライン専用のため、stt-design.mdの
「partial: 0.5秒間隔で更新」は実現できず、「VAD区間検出→区間ごと一括認識」
に設計変更した。ウェイクワードは設定から複数登録でき、正式語は5文字以上に
制限する。長いSTTセグメント中の正式語を検出し、短縮・同音誤認識は同じ話者の
注意キューがある場合だけ回復する（`docs/archive/openai-test-handoff.md`参照）。

### 呼びかけ検知・ラウンド管理層（本PoCの成果）
- **先行投機実行**: ウェイクワード検知後、猶予ウィンドウで待たず即座に本体LLMへ
  第1ラウンドとして送信。並行して2秒程度の猶予ウィンドウを開く
- **関連性判定**: 猶予ウィンドウ中の追加発話は、軽量モデル（GPT-5.6 Luna等）で
  「呼びかけの続きか無関係な発話か」を判定してから扱いを決める
- **文単位グレースフル中断**: 中断が必要と判定されても即座にストリームを切らず、
  現在組み立て中の文（句点区切り）を完成させてから残りを破棄して次ラウンドへ
- 判定不要になった設計: 文頭型／文末型／単独+間、という発話パターンの事前分類は
  不要。すべて同一のステートマシンで吸収される

### 本体LLM層
- 初期: OpenAI GPT-5.6 Sol
  - 2026年6月26日プレビュー公開、7月1日に一般提供再開（輸出規制の一時停止措置あり）
  - Responses API、function calling・vision入力対応
- 将来: ローカル Qwen3.6-35B-A3B
  - 35B総パラメータ・3B活性化のMoEモデル、Apache 2.0ライセンス
  - function calling・vision入力・262K文脈対応
  - vLLM/SGLangでOpenAI互換エンドポイントを立てられるため、SDKのbase_url差し替えのみで移行可能
  - VRAM目安 22GB前後（量子化次第）
- ツール定義:
  - `web_search` — 実行環境側の`SearchProvider`を使うWeb検索。既定は
    SearXNG、MockとOpenAI Web Searchへ交換可能。詳細は`docs/web-search.md`
  - `save_memory` / `search_memory` — DB保存・検索（記憶）
  - `capture_obs_screenshot` — OBS WebSocket経由のスクショ取得
  - `read_discord_chat` / `search_discord_history` — Discordチャット閲覧・履歴検索

### 記憶(DB)層
LLMに渡すトークンを4種類に整理し、それぞれ扱いを変える。

```
システムプロンプト  ─┐
短期記憶（要約+事実）─┼─ 毎回そのままinputに含める
現在の問いかけ       ─┘
長期記憶（ベクトルDB）─── inputには含めず、search_memoryツール呼び出しでLLMが自分で取りに行く
```

- **短期記憶**: 直近の会話ログの要約 + そこから抽出した重要な事実。
  会話ログが一定件数（既定10件）を超えたら、古い部分だけを軽量モデルで
  要約に圧縮し、生ログは直近分（既定6件）だけ残す。バックグラウンドで
  非同期実行し、応答のIDLE復帰は待たせない
  （実装: `src/session/zundamonSession.ts` の `compactMemory`、
  `src/memory/shortTermMemory.ts`）
- **長期記憶**: ローカルQdrant（ベクトルDB、`text-embedding-3-small`で
  埋め込み）に `save_memory` / `search_memory` ツール経由で保存・検索する。
  全ログ保存ではなく、AIが「今後も参照する価値がある」と判断したものだけを
  save_memoryで保存する自己判定方式（システムプロンプトで指示）。
  「階層化」はカテゴリ(preference/fact/event/other)・重要度(1〜5)を
  Qdrantのpayloadに持たせ、フィルタ付き検索で表現する
  （実装: `src/memory/longTermMemory.ts`、`src/memory/embeddings.ts`、
  `src/memory/memoryTools.ts`）
- 実測で判明した罠: `reasoning_effort`を無効化した軽量モデル
  (gpt-5.6-luna)は、単に「必要なら検索して」という指示だけでは
  search_memoryを呼ばず「知らない」と答えてしまうことがあった。
  「答える前に必ず1回search_memoryを呼び出すこと。呼ぶ前に知らないと
  結論づけないこと」まで踏み込んで指示する必要があった
  （`docs/archive/openai-test-handoff.md`参照）

### 出力層
- VOICEVOXで音声合成 → discord.jsの`VoiceConnection`でDiscordボイスチャンネルへ
  ストリーム再生
- 文単位で合成キューに投入する設計（グレースフル中断と対応）

## 未確定・要検討事項（次のステップ）

1. ~~STT〜呼びかけ検知〜LLM層の実配線~~ → 実装済み。
   `src/discordBot.ts`で`VoiceReceiverAdapter`から
   `ZundamonSession.onFinalUtterance`へ接続し、応答をDiscord再生キューへ渡す。
   STT単体の疎通（`npm run stt:test` / `stt:stream-test`）と型チェックは済み。
   2026-08-27、実際のDiscord環境で一人の話者による約30秒の日本語会話ループを
   実地検証し、発話ごとのSTT、STT→ウェイク検知→OpenAI LLM→ローカル
   VOICEVOX→ffmpeg/Discord再生の一気通貫動作を確認した。修正後の約6分の
   安定試験では30秒ループ10/10（正式語6/6、注意キュー付きの短縮・同音候補
   4/4）と追加の手動呼びかけ2/2で応答した。短い`んだもん`単独発話には
   反応せず、再生・circular-buffer・要約タイムアウトのエラーもなかった。
   **未検証**: 複数人の同時発話。
   ウェイクワードは`.env`から変更・追加でき、正式語をUnicode 5文字以上に
   制限する。正式語は長いSTTセグメント中でも検出し、5文字未満の短縮・同音候補は
   同じ話者の直前または同一セグメントに注意キューがある場合だけ受理する。
   `test/testWakeword.ts`と`test/sessionWakeword.test.ts`で別キャラクター名、
   複数登録、最長一致、話者分離、口語表現との衝突回避を確認済み。
2. ~~VOICEVOX層との接続~~ → 解決済み。`onSentenceReady`を実際の合成+
   スピーカー再生(`RealPlaybackQueue`)につなぎ込み、`npm run cli`で
   テキスト入力→実音声再生まで通しで動作することを確認した
3. ~~discord.js音声受信・送信と本体への配線~~ → 実装済み。
   **個別の送信・受信は疎通確認済み**。
   送信は`npm run discord:test`（ログイン→ボイスチャンネル参加→VOICEVOX
   音声再生→テキストチャンネルへ報告）、受信は`npm run
   discord:receive-test`（実際の発話をSTTで認識、話者ごとに
   `MultiSpeakerStt`で分離）で確認した。native buildを避けopusscript
   (pure JS Opus) + libsodium-wrappers(pure JS/WASM暗号化)を採用。
   `src/discordBot.ts`と`src/discord/`で`ZundamonSession`本体への配線、
   Discord向け再生キュー、終了処理まで実装済み。再生キューの自動テストは
   `npm run test:discord-playback`で確認できる。
   上記の2026-08-27実地検証で、音声受信→STT→セッション→音声再生の
   エンドツーエンド動作を確認済み（ffmpeg 9.0.1）。複数人の同時発話は未検証。
4. ~~記憶DBのスキーマ・ベクトル化方式~~ → 解決済み（本ドキュメントの
   「記憶(DB)層」参照）。残課題: 長期記憶の自動保存判定の精度検証・
   短期記憶の圧縮閾値のチューニング
5. ~~判定コスト最適化~~ → 解決済み。ウェイクワードのみ(本題が空)の
   追加発話はLLM判定を呼ばずローカルで「継続なし」に確定するようにした
   （`zundamonSession.ts`の`handleFollowup`、`test/testJudgeOptimization.ts`
   で判定リクエスト数が増えないことを確認）
6. ~~話者複数対応~~ → ベースライン実装済み。(a) `Utterance.speakerName` /
   `ChatMessage.name`（OpenAI APIのmessage.name）で会話ログ上の発言者を
   区別できるようにした（`test/testMultiSpeaker.ts`で2話者の発言に
   異なるnameが付くことを確認）。(b) STT側は`MultiSpeakerStt`
   （`src/stt/multiSpeakerStt.ts`）で話者ごとに独立したSttEngineを
   管理する設計にした（stt-design.mdの方針どおり）。**未対応**:
   セッション(状態機械)自体は依然1つ共有（複数話者が同じ会話に参加する
   前提で、各話者に個別のZundamonSessionは持たせていない。今のところ
   これは意図した設計 — 詳細はstt-design.md「Discord音声受信との接続」）
7. newRoundのバックログ破棄における「打ち切り意図」判定の精度検証
   （`docs/archive/openai-test-handoff.md`参照）
8. ~~Discord音声受信のcircular-bufferバグ~~ → 実装上の修正済み。Opusのレビュー
   （CLAUDE.md参照）でsherpa-onnx本体のソースから原因を確定: `Vad.flush()`
   がバッファを空にするだけでSileroモデルの内部状態(triggered_フラグ)を
   クリアしないupstreamのバグだった。`SttEngine.reset()`を実装し、
   `flush()`実行後に自動でVAD/バッファを完全リセットするようにした
   （モデル自体は再ロードしない軽量な操作）。あわせて`OfflineRecognizer`
   （160MB超・ステートレス）を話者間で共有する設計に変更し
   （`MultiSpeakerStt`）、話者数に対するメモリ増加を防いだ。
   2026-08-27の実環境テストで反復発話を確認し、circular-bufferエラーは
   再発しなかった。
9. 長期記憶（Qdrant）の実セッション検証。今回のテストではQdrantを停止していたため、
   memory toolsは未検証。
10. ウェイク前の雑談を会話ログへ保持する範囲の見直し。現在は周辺の雑談が
    応答へ混ざることがあるため、直近の短い窓だけ保持するか、呼びかけ後の発話だけを
    本体LLMへ渡すかを決めて実地評価する。
11. ~~Web検索のモデル依存解消~~ → `SearchProvider`境界と`web_search`ツールを
    実装。既定はローカルSearXNG、試験用Mock、任意のOpenAI Responses API検索を
    同じ結果形式で差し替えられる。天気専用ツールとMCPサーバー化は必要性が出た
    段階で追加する。SearXNGを使ったDiscord実地検索は未検証。
