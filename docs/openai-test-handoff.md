# OpenAI API 実測テスト — 引き継ぎメモ

新しいセッション/環境から再開するための記録。
ブランチ: `claude/openai-api-test-c5vast`

## 現在の状態

**実測完了（2026-08-26）。** `gpt-5.6-sol` / `gpt-5.6-luna` は実在するモデルで、
`.env` の既定値のまま preflight・4シナリオとも一発で通った（モデル名の
差し替えは不要だった）。

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | OK |
| `npm run scenarios` | OK（モック・既存挙動の回帰なし） |
| `npm run test:fake` | PASS（S1〜S4全通過 + 中断時のHTTP切断をサーバ側から確認） |
| `npm run preflight` | OK（詳細は下記） |
| `npm run scenarios:real` | PASS（S1〜S4全通過、詳細は下記） |

`test:fake` は `scenarios:real` と同一の `OpenAILLMClient`・同一シナリオ実装を
ローカルのOpenAI互換サーバに向けて実行する。実APIとの差はモデルの中身だけ。

### preflight 実測値

- 認証OK、利用可能モデル126件中に `gpt-5.6-sol` / `gpt-5.6-luna` を確認
- **初トークンまでのレイテンシ: 2752ms**（`GRACE_WINDOW_MS`=2000ms を超過 ⚠）
- 判定（judgeContinuation）往復: 2545ms
- `response_format: json_object` はパース成功。`isContinuation` 判定も理由付きで妥当な出力

### scenarios:real 実測値

S1〜S4すべてPASS。狙い通り両方の追加発話経路を実地で確認できた。

| シナリオ | 結果 | 経路 |
|---|---|---|
| S1 単独の呼びかけ | PASS | — |
| S2 無関係な追加発話 | PASS | `ignored` |
| S3 関連する追加発話（グレースフル中断） | PASS | `interrupt` |
| S4 応答完了後の追加発話 | PASS | `newRound` |

### 実行環境メモ

検証環境に Node.js/npm が未導入だったため `winget install --id
OpenJS.NodeJS.LTS -e` で導入した（npm 11+ の allow-scripts 機能により
`esbuild` の postinstall が保留されるので `npm approve-scripts esbuild`
が別途必要）。次回別環境で再開する場合の参考に記載。

### APIキーのTier制限（要順守）

このキーはTier 1。**許可リスト外のモデルを使わないこと**、定期的に
USAGEを確認すること。`.env` 冒頭にモデル一覧のコメントを記載済み。
本PoCで使う `gpt-5.6-sol`（フラッグシップ系・250Kトークン/日上限）・
`gpt-5.6-luna`（軽量系・2.5Mトークン/日上限）はどちらも許可リスト内。

## 再開手順（別環境で再検証する場合）

```bash
npm install
npm run preflight        # ← 必ず先に。課金前にモデル名で弾ける
npm run scenarios:real
```

`OPENAI_API_KEY` は環境変数か `.env`（gitignore済み）のどちらでもよい。
既定のモデル名は実在確認済みなので、通常は書き換え不要。

## 実APIを叩く前に直したバグ（コミット d6a2ddc）

モック（`mockClient`）はSDKを通らないため実API固有の経路が未検証だった。
フェイクサーバ越しに実行して出たもの。

- **中断エラー判定が `DOMException` のみ** → OpenAI SDKは
  `APIUserAbortError` を投げるため、中断のたびに想定外エラーとして再スロー
  されていた。`src/llm/errors.ts` の `isAbortError` で吸収。
- **判定中にラウンドが完走する競合** → 死んだラウンドに中断要求を出し、
  追加発話が握り潰されていた。現在は新ラウンドとして走らせる。
- **break後もHTTPストリームが開いたまま** → 捨てたはずのトークンを受信し
  続ける＝課金の垂れ流し。`finally` で `stream.controller.abort()`。
- **ラウンドが detached で例外が消える** → モデル名ミスや認証エラーが
  unhandled rejection として無言で消滅していた。`onError` イベントを追加。
- **判定JSONの素の `JSON.parse`** → フェンス/前置きで例外。寛容化し、
  失敗時は「継続なし」に倒す。
- **tsconfig が `@types/node` を拾えず** `tsc` が最初から通らなかった。

## 音声再生時間が考慮されていなかった問題（発見・修正済み）

`onSentenceReady(sentence)` はテキストが1文完成するたびに呼ばれる同期の
fire-and-forgetで、VOICEVOXの合成・再生時間を待つ仕組みが無かった。
「グレースフル中断＝現在の文を言い切ってから止める」の"文"は**テキスト生成
時間の中の文**であり、**実際に耳に届く音声の中の文**ではなかった。

LLMのトークン生成速度は音声再生よりずっと速いため、テキストストリームは
音声キューをどんどん追い越して先に進む。中断要求が届いた時点で、実際には
まだ1文目すら再生し終わっていないのに、テキスト側はすでに5〜10文先まで
生成済み——という状況が普通に起きる。従来コードは「未来のテキスト生成」
を止めるだけで、**既にキューに積まれてしまった未再生の文を一切破棄して
いなかった**ため、中断してもキューに溜まった分がそのまま最後まで再生され
続けるはずだった（実際の再生はまだ繋がっていないため気づきにくいバグ）。

### 修正

[`src/session/audioClock.ts`](../src/session/audioClock.ts) に、文字数から
再生時間を概算する仮クロック（0.1秒/文字、VOICEVOX未接続の間のプレース
ホルダー）を追加。`onSentenceReady` のたびにこのクロックへ積み、中断が
決まった瞬間に「まだ再生開始していない（＝テキストは生成済みだが未来の）
文」をキューから破棄するようにした（`truncateToCurrent`）。

### 実測（`npm run scenarios:real` / S3）

修正前は0文破棄（バグに気づかず全部再生される想定だった）。修正後:

| 実行 | 破棄した文 | 破棄した文字数 | 音声換算の節約時間 |
|---|---|---|---|
| フェイクサーバ | 4文 | 47文字 | 4.7秒 |
| 実API 1回目 | 5文 | 159文字 | 15.9秒 |
| 実API 2回目 | 9文 | 218文字 | 21.8秒 |

実APIでは応答が長くなりやすく、テキスト生成と音声再生のズレが**20秒前後**
にまで達することも確認できた。中断機構は直っていなければ、ユーザーが
「やっぱりいいや」と言ってから20秒近く関係ない話を聞かされ続けていた
計算になる。

### 未対応の関連課題

- **newRoundパス側は明示的な対応は不要だった**: `AudioClock` はセッション
  全体で1つ持ち続け、新しい文は「前の音声の再生が終わってから」順番に
  積まれる設計にしたため、ラウンドをまたいでも自然に音声が重ならない。
- **Markdown記法が生のままキューに入っている**: `**リュックサック**` の
  ような装飾記号や箇条書き番号がそのまま文として扱われている。実際に
  VOICEVOXへ渡す前にテキスト整形（記号除去）が必要になる。
- **0.1秒/文字はあくまで仮の概算**。VOICEVOXと接続したら実測値に差し替える
  こと。

## 判定LLMの誤判定を実測で確認（別問題）

`npm run scenarios:real` の S2（無関係な追加発話は無視されるはず）が、
2回中2回とも異なる理由でFAILした。

1. 1回目: 判定往復がテストハーネスの待機時間（`quietMs`=2.5秒）より遅く、
   判定が返る前に「静止した」と判断されテストが終了した
   （ハーネス側のタイミング競合。セッションのバグではない）。
2. 2回目: 判定モデル(`judgeModel`)が「そういえば昨日の試合見た？」という
   明らかに無関係な発話を **`isContinuation=true`（継続）と誤判定**し、
   実際に第2ラウンドが走ってしまった。

2回目は設計上の想定外。judgeModelの精度は完璧ではなく、無関係な発話が
誤って割り込みとして扱われるケースが実測で確認できた。実運用前に、
判定プロンプトの調整（誤判定率の実測・改善）を検討する価値がある。

`logs/llm-calls.jsonl`（後述）に実際の判定理由が残っている:

> 発話: "そういえば昨日の試合見た？"
> `is_continuation: true`
> reasoning: 「直前に音声アシスタントへ呼びかけており、新しい発話も
> 「見た？」と相手に問いかける形なので、話題転換はあるもののアシスタント
> への続きと判断できます。」

「〜？」で終わる疑問形というだけでアシスタント宛と判定してしまっており、
話題の関連性より文の形（疑問形かどうか）に引っ張られている可能性がある。
判定プロンプトの調整余地として記録しておく。

## LLM呼び出しログを追加

これまでは `npm run scenarios:real` 等のコンソール出力（要約・文単位の
ログ）しか残らず、LLMに実際何を送って何が返ってきたかを後から確認する
手段が無かった。[`src/llm/callLogger.ts`](../src/llm/callLogger.ts) を追加し、
`OpenAILLMClient` の `streamChat`（本体）・`judgeContinuation`（判定）
それぞれの呼び出しごとに、送信した `messages` と実際の応答テキスト・
レイテンシを `logs/llm-calls.jsonl`（gitignore済み、1呼び出し1行JSON）に
記録するようにした。グレースフル中断で打ち切られた場合も、非同期
ジェネレータの `finally` は実行される（消費側の `break` で暗黙に
`.return()` が呼ばれる仕様）ため、打ち切りまでに生成された分がそのまま
ログに残る。

上の「判定LLMの誤判定」はこのログで見つけたもの。実行するたびに追記
されるので、複数回の実行結果を横断して見たい場合はファイルごと退避する
こと。

## ツールコール（function calling）疎通確認

本体ロジックには未組み込みだが、`/v1/chat/completions` でツールコールが
そもそも動くかを [`src/toolCallTest.ts`](../src/toolCallTest.ts)（`npm run
toolcall`）で単発確認した。ダミーの `web_search` 関数1つを渡し、
モデルが呼び出しを選ぶか・結果を受けて最終応答を作れるかを見るだけの
テスト。

**結果: 往復まで含めて成功。** ただし1つ罠があった。

> `BadRequestError: 400 Function tools with reasoning_effort are not
> supported for gpt-5.6-luna in /v1/chat/completions. To use function
> tools, use /v1/responses or set reasoning_effort to 'none'.`

`gpt-5.6-luna`（および恐らく同系列のreasoningモデル全般）は、
`reasoning_effort` が有効なままだと `/v1/chat/completions` 経由の
function toolsを拒否する。リクエストに `reasoning_effort: "none"` を
明示するか、`/v1/responses` エンドポイントを使う必要がある。
`reasoning_effort: "none"` を指定したところ問題なく通り、

```
web_search({"query":"東京 今日 天気 2026年8月26日"})
```

のように日付まで補って自然にツールを呼び、ダミーの検索失敗結果を渡すと
「検索したけど取得できなかった、気象庁で確認してほしい」と破綻せず
最終応答を組み立てた。ずんだもんセッション本体（`OpenAILLMClient`）は
今のところツールを一切渡していないので、これは影響しない。将来
ツールを組み込む場合はこの`reasoning_effort`の扱いを踏まえること。

## 実音声再生つきで onSentenceReady をつなぎ込んだ結果

[`src/ttsPlaybackDemo.ts`](../src/ttsPlaybackDemo.ts)（`npm run tts:playback-demo`）で、
`onSentenceReady` を実際の合成(su-shiki)+ホストスピーカー再生
（[`src/tts/playbackQueue.ts`](../src/tts/playbackQueue.ts)、Windows専用で
`System.Media.SoundPlayer` を使用）につなぎ込み、実際に音を鳴らして検証した。

### 見積り(0.1秒/文字) vs 実測

毎回、実測が見積りより+1.3〜2.0秒ほど多くかかったが、**差は文字数に比例
しなかった**（16文字でも31文字でもほぼ同じ差）。これは音声の長さそのもの
というより、**1文ごとにPowerShellプロセスを新規起動しているオーバーヘッド**
が支配的と考えられる。実際の音声再生速度自体は0.1秒/文字に近い可能性が
高い。Discord実装では常駐プロセス経由になるはずなので、このオーバーヘッド
は実運用では縮む見込み。プロセス起動を伴わない実装に差し替えたら再計測
すること。

### 新たに見つかった問題: newRound経路はバックログを破棄しない

「ずんだもん、遠足の持ち物を5個、順番に説明して」の1文目の**再生開始と
同時に**「やっぱりいいや、今何時なのだ？」を注入したところ、判定LLM
(luna)は`continuation=true`と正しく判定したにもかかわらず、
**中断(`onAudioTruncated`)は一度も発火しなかった**。

原因: 本体モデル(luna)のテキスト生成が非常に速く、判定往復(約2.5秒)が
返ってくる前に5文すべてのテキスト生成が完了していた。`abortController`は
既にnullだったため`newRound`経路に入り、`interrupt`経路にしか無い
バックログ破棄ロジックが一切働かなかった。

結果、実際の音声キューには「遠足の持ち物」の残り4文がそのまま積まれた
状態で「今何時なのだ」の応答(文6,7)がその**後ろに**追加され、ユーザーは
「やっぱりいいや」と言ったのに聞きたくもない持ち物リストを最後まで
（実測で合計17秒程度）聞かされてから、ようやく本題の回答を聞く形になった。

これは「中断時に未再生キューを破棄する」修正（本ドキュメント前半）の
対象外だったケース。`interrupt`/`newRound`という分岐は**テキスト生成が
続いているかどうか**の判断であり、**音声がまだ再生し終わっていない**
状況を考慮していない。

**未決の設計判断（次に決めること）**: `continuation=true`と判定されたら
経路によらず常にバックログを破棄すべきか？　ただしS4（「ついでに自己紹介
して」のような**追加**要求）まで巻き込んで直前の発話を切ってしまうと
過剰破棄になる。「やっぱりいいや」的な**破棄意図**と「ついでに」的な
**追加意図**を判定LLM側で区別させる（`is_continuation`とは別に
`should_discard_current`のようなフィールドを持たせる等）必要がありそう。

## newRoundのバックログ破棄問題を修正

判定LLMの出力に `abandons_current`（今の応答を打ち切りたい意図か／追加で
聞きたいだけか）を追加した。「やっぱりいいや」的な**打ち切り**と
「ついでに」的な**追加**を区別させ、`newRound`経路でも打ち切り意図なら
音声キューの未再生分を破棄するようにした
（[`zundamonSession.ts`](../src/session/zundamonSession.ts)の`handleFollowup`）。
`interrupt`経路（テキスト生成が続いている場合）の挙動は変更していない。

判定応答は `{"is_continuation": boolean, "abandons_current": boolean,
"reasoning": string}` に拡張（[`openaiClient.ts`](../src/llm/openaiClient.ts)、
`mockClient.ts`、`fakeOpenAIServer.ts`も追随）。フェイクサーバに新規
シナリオ**S5**（S4と同じ`newRound`経路だが打ち切り要求）を追加し、
「S4は破棄しない／S5は破棄する」をアサートするようにした
（`test/fake` `test:fake`で5/5 PASS）。

実API・実音声再生（`tts:playback-demo`）でも確認: 「ずんだもん、遠足の
持ち物を5個」の1文目再生中に「やっぱりいいや、今何時なのだ？」を注入した
ところ、シミュレーション(audioClock)・実キュー(RealPlaybackQueue)の両方で
即座に未再生分が破棄され、時刻の応答がすぐ流れるようになった
（修正前は最後まで持ち物リストを聞かされていた）。

## 再生オーバーヘッドの切り分け・解消

[`src/ttsOverheadTest.ts`](../src/ttsOverheadTest.ts)（`npm run
tts:overhead-test`）で、TTS合成は1回だけ行い、同じWAVを
「(A) 再生のたびにPowerShellプロセスを新規起動」「(B) プロセスを1つ
使い回す」の両方で再生して壁時計を比較した。あわせてWAVヘッダから
音声そのものの実長も読み取り（[`tts/wav.ts`](../src/tts/wav.ts)）、
3者を突き合わせた。

| 文字数 | WAV実長 | 方式A(毎回起動) | 方式B(使い回し) |
|---|---|---|---|
| 8文字 | 1291ms | 1781ms (+490ms) | 1445ms (+154ms) |
| 10文字 | 1611ms | 1976ms (+365ms) | 1678ms (+67ms) |
| 28文字 | 4800ms | 5185ms (+385ms) | 4873ms (+73ms) |

**平均オーバーヘッド: 方式A=414ms → 方式B=98ms（約76%削減）。** プロセス
起動コストが犯人だったことを実測で確定。[`src/tts/playback.ts`](../src/tts/playback.ts)
に`PersistentPowerShellPlayer`を追加し、`RealPlaybackQueue`はこちらを
既定で使うように変更した（`playWavFile`は単発確認用として残置）。

副産物として、**WAVの実長自体が0.1秒/文字より遅い**ことも判明した
（161〜171ms/文字、平均約0.165秒/文字）。`audioClock.ts`の
`SEC_PER_CHAR`を0.1→0.165に更新した（サンプル数3件のみのため、今後の
実測でさらに精緻化してよい）。

## SushikiTTSClientの異常系テスト

[`test/fakeTTSServer.ts`](../test/fakeTTSServer.ts) +
[`test/runTTSErrorTests.ts`](../test/runTTSErrorTests.ts)（`npm run
test:tts-fake`）で、`test/fakeOpenAIServer.ts`と同じ発想のフェイクサーバを
使い、以下を無料・確実に検証した（7/7 PASS）:

- 音声合成: 正常系／HTTP 500／200だが音声でない本文（`notEnoughPoints`等の
  実運用エラーを想定）→ いずれも想定通り
- 話者一覧: 正常系／HTTP 500／壊れたJSON／配列でない想定外スキーマ
  （これは例外にせず空配列を返す設計を確認）→ いずれも想定通り

あわせて実APIに**わざと不正なキー**で1回だけ`synthesize`を叩き、実際の
エラー形式を確認した（合成前の認証エラーのためポイント消費は無いと
思われる）:

```
status=403, content-type="application/json"
{"errorMessage":"invalidApiKey"}
```

公式ドキュメントに記載のエラーコード名(`invalidApiKey`)と一致。現在の
実装（`!res.ok || !contentType.startsWith("audio/")`で失敗とみなす）は
このケースを正しく検知できることを確認済み。「記号を含む入力でパースが
崩れるか」は検証していない（クライアント側のエラー処理ではなくVOICEVOX
側の合成品質の話であり、実API課金を伴う割に得られる情報が少ないため
スコープ外とした）。

**追記**: `notEnoughPoints`も実際に本番で踏んだ（`tts:playback-demo`実行中に
ポイント枯渇）。エラー形式は`invalidApiKey`と同じ`403 + {"errorMessage": ...}`
で、想定通り`TTSError`として検知でき、`RealPlaybackQueue`のエラーハンドリング
（`onError`で捕捉してセッション全体は落とさない）も正しく機能した。

**⚠ 現在SUSHIKI_API_KEYのポイントが枯渇している。** 次にTTS系スクリプト
（`tts:test`/`tts:playback-demo`/`tts:overhead-test`）を実行する前に、
https://su-shiki.com/api/ でポイント残量を確認すること。

## 未決の設計判断（実測値が出たので判断できる状態）

### 1. 追加発話が通る2経路

判定LLMの往復時間と本体応答の残り長さの大小で分岐する。

```
判定が返った時点で……
  まだ喋っている   → interrupt : 文を言い切ってから破棄し、次ラウンドへ
  もう喋り終わった → newRound  : 中断するものが無いので、そのまま次ラウンド
```

**実測で両経路とも自然に踏まれることを確認済み**（S3=`interrupt`,
S4=`newRound`）。判定往復は2545ms、S3では長い応答（遠足の持ち物10個）
だったため `interrupt` に落ちたが、システムプロンプトが「短く簡潔に」を
指示している通常応答では `newRound` のほうが多く通る可能性が高いという
仮説は実測後も変わらず妥当。判定を軽量化するかは実運用のログを見てから
判断でよい。

### 2. `GRACE_WINDOW_MS` の見直しが必要（実測で確定）

初トークンまでのレイテンシが **2752ms** と、猶予ウィンドウの2000msを
上回った。先行投機実行は「初トークンが猶予ウィンドウ内に返る」ことを
暗黙の前提にしていたため、**この前提はすでに崩れている**。

- 窓を2752ms以上（安全マージンを見て3〜4秒程度）に伸ばす
- 「応答中はいつでも割り込める」を正とし、タイマー自体を撤去する

のどちらかを選ぶ必要がある。preflightは1回のサンプルなので、実運用投入
前に複数回計測してレイテンシのばらつき（p50/p95）を見ておくとよい。

## ファイルの見取り図（今回追加分）

```
src/config.ts           .env読み込みと構成表示（課金事故の予防）
src/preflight.ts        認証・モデル名実在確認・レイテンシ実測
src/scenarioRunner.ts   シナリオ定義と実行（real / fake で共用）
src/realScenarios.ts    実APIエントリ
src/llm/errors.ts       中断エラー判定（SDK差異の吸収）
src/session/audioClock.ts テキスト生成と音声再生のズレを追跡する仮クロック
test/fakeOpenAIServer.ts  OpenAI互換フェイクサーバ（SSE・切断検知つき）
test/runAgainstFake.ts    フェイクサーバ統合テスト
test/serveFake.ts         フェイクサーバ単体起動
```

シナリオランナーは固定sleepではなく**「N文目が完成した瞬間」をトリガに
追加発話を注入する**。手入力やsleepだと割り込みタイミングが応答速度に
依存して再現しないため。
