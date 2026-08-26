# STT（音声認識）層 設計

## 結論：hayamimiは経由せず sherpa-onnx-node を直接使う

### hayamimi(oboroge0/hayamimi)の評価
- CPU専用・多言語対応のリアルタイム音声認識ツール
- 日本語はReazonSpeechが学習したZipformerモデルを`sherpa-onnx`ランタイムで
  実行しているだけ。中国語はParaformer、韓国語/広東語はSenseVoice、
  英語+EU24言語はParakeet、その他約1600言語はMeta Omnilingual ASR、と
  **既存の公開モデルをsherpa-onnx経由で呼び分けているだけ**
- hayamimi自体の独自価値は「言語ルーティング」「VAD連携」「partial/final分割」
  「2パス精緻化」「LRUメモリ管理」という**配線・調整部分のみ**
  - モデル自体の独自性はゼロ
- 日本語実測: CER 5.8%（beam search、実放送音声）。whisper-large-v3-turboの
  13.8%の半分以下。6コアCPUで10-50倍速のリアルタイム係数。メモリ2GB未満
- Python製。Node.js統一方針とは言語が合わない

### 方針
`sherpa-onnx`は公式にNode.jsバインディング（`sherpa-onnx-node`、napi経由）を
提供しており、hayamimiが内部で使っているのと**全く同じモデル**を直接ロードできる。
hayamimiをforkする必要はなく、以下を自前実装する：

- VAD（Silero VAD、sherpa-onnx-node同梱）による発話区間検出
- partial/final分割ロジック（hayamimiの設計を参考にした軽量なTypeScript実装）
- 言語ごとのモデルルーティング

## モデル選択（差し替え可能な設計）

英語・欧州語族への対応を残すため、**言語タグ→モデル設定のマッピングテーブル**
方式にする。モデルはsherpa-onnxのモデルカタログから選択・差し替え可能。

```typescript
interface ModelConfig {
  modelId: string;
  quant?: "int8" | "fp16" | "fp32";
}

const MODEL_ROUTES: Record<string, ModelConfig> = {
  ja: { modelId: "reazonspeech-zipformer", quant: "int8" },   // 速度重視
  // 精度重視に切り替える場合: { modelId: "reazonspeech-espnet-v2" }
  en: { modelId: "parakeet-tdt-0.6b-v3" },
  de: { modelId: "parakeet-tdt-0.6b-v3" },   // 欧州24言語をカバー
  fr: { modelId: "parakeet-tdt-0.6b-v3" },
  es: { modelId: "parakeet-tdt-0.6b-v3" },
  // ... 他の欧州言語も同様にParakeetでカバー
  default: { modelId: "whisper-large-v3-turbo" },  // 未対応言語のフォールバック
};
```

### 用途別モデル比較（2026年時点のベンチマーク調査より）

| 用途 | モデル | 備考 |
|---|---|---|
| 日本語・配信の雑談・リアルタイム重視 | ReazonSpeech Zipformer | RTF最速クラス（hayamimiと同じ） |
| 日本語・精度最優先 | reazonspeech-espnet-v2 | 日本語メディア特化でCER最良級 |
| 日本語・IT/専門用語が多い | qwen3-asr | 略語崩れが少ない傾向 |
| 英語・欧州語族 | Parakeet (NVIDIA) | 24言語対応、Node.jsでも動作 |
| 汎用フォールバック | whisper-large-v3-turbo | 多言語対応の保険 |

いずれもsherpa-onnxのモデルカタログに載っているため、**モデルファイルを
差し替えるだけ**で切り替えられる。まずはReazonSpeech Zipformer（日本語）+
Parakeet（英語・欧州語）で組み、精度が気になったら個別に差し替える。

## 言語判定（LID）

- **発話ごとに判定する**（方針確定）。理由: バイリンガル話者が存在するため、
  話者IDに紐づけて言語をキャッシュする方式は破綻する
- 発話冒頭数秒をwhisper-tinyクラスの軽量LIDモデルに通して言語タグを出す
  （hayamimiと同様のアプローチ）

## VAD・partial/final分割

- Silero VAD（sherpa-onnx-node同梱）
- 無音判定の閾値: 初期値0.35秒（hayamimiのデフォルトを踏襲）
- partial: 発話中0.5秒間隔で更新
- final: 無音判定と同時に確定
- 2パス精緻化（無音2秒後の再デコード）は初期実装では見送り、精度が
  不足する場合に追加検討

## メモリ管理

- 複数言語モデルを同時ロードしない。LRU方式で非アクティブなモデルを
  アンロードする（hayamimiの`--max-resident`と同じ発想）
- 上限は要実測（hayamimiは`<2GB RAM`が目安）

## Discord音声受信との接続

- discord.js `@discordjs/voice`の`receiver.subscribe(userId)`で
  ユーザーごとのOpus/PCMストリームを取得
- PCMストリームをそのままsherpa-onnx-nodeのVAD入力へ流し込む
- 複数話者が同時に話すDiscordの特性上、**話者ごとに独立したVAD/STT
  パイプラインインスタンス**を持たせる設計とする
  （hayamimiの`--speakers`のようなturn-takingラベリングは不要になる。
  Discord側で既にユーザー単位にストリームが分離されているため）

## 未確定・要検討事項

1. LIDの判定タイミング（発話冒頭何秒を使うか）とレイテンシへの影響
2. 話者ごとに独立したSTTパイプラインを持たせた場合のメモリ・CPU負荷
   （同時発話者数が多い配信でのスケーラビリティ）
3. VADパラメータ（無音判定0.35秒等）の実配信での実測調整
4. 2パス精緻化の要否判断基準
