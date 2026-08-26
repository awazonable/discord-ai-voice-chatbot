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
→ 別紙 `stt-design.md` 参照

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
- ツール定義（想定）:
  - `web_search` — ブラウザ検索
  - `save_memory` / `search_memory` — DB保存・検索（記憶）
  - `capture_obs_screenshot` — OBS WebSocket経由のスクショ取得
  - `read_discord_chat` / `search_discord_history` — Discordチャット閲覧・履歴検索

### 記憶(DB)層
- 全ログ保存ではなく、**AIが必要と判断したものだけ保存**
- 返答後に「これ覚えておく？」を自己判定するハーネスを挟む
- 過去記憶をさかのぼる検索フェーズ（RAG的な事前検索）も別途必要
- 未確定: DBスキーマ・ベクトル化方式

### 出力層
- VOICEVOXで音声合成 → discord.jsの`VoiceConnection`でDiscordボイスチャンネルへ
  ストリーム再生
- 文単位で合成キューに投入する設計（グレースフル中断と対応）

## 未確定・要検討事項（次のステップ）

1. STT〜呼びかけ検知〜LLM層の実配線（本PoCコードの接続）
2. VOICEVOX層との接続（`onSentenceReady`イベントの先）
3. discord.js音声受信・送信の実装
4. 記憶DBのスキーマ・ベクトル化方式
5. 判定コスト最適化（呼びかけ語のみのケースをローカルヒューリスティックで先に弾く等）
6. 話者複数対応（現状のPoCは1話者分の設計）
