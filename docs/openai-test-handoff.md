# OpenAI API 実測テスト — 引き継ぎメモ

新しいセッション/環境から再開するための記録。
ブランチ: `claude/openai-api-test-c5vast`

## 現在の状態

**未達: 実APIでの実測はまだ行えていない。** テストを書いた環境に
`OPENAI_API_KEY` が無かったため（`api.openai.com` への疎通自体はHTTP 401で確認済み）。
キーのある環境で下記4行を流せば完了する。

キー無しで検証できた範囲は以下。すべてグリーン。

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | OK |
| `npm run scenarios` | OK（モック・既存挙動の回帰なし） |
| `npm run test:fake` | PASS（S1〜S4全通過 + 中断時のHTTP切断をサーバ側から確認） |

`test:fake` は `scenarios:real` と同一の `OpenAILLMClient`・同一シナリオ実装を
ローカルのOpenAI互換サーバに向けて実行する。実APIとの差はモデルの中身だけ。

## 再開手順

```bash
npm install
npm run preflight        # ← 必ず先に。課金前にモデル名で弾ける
npm run scenarios:real
```

`OPENAI_API_KEY` は環境変数か `.env`（gitignore済み）のどちらでもよい。

### preflight は初回おそらく失敗する（想定内）

既定の `gpt-5.6-sol` / `gpt-5.6-luna` は**設計時の仮称**であり、実在しない
可能性が高い。preflight は `/v1/models` を取得して照合し、実在しなければ
候補一覧を出して exit 1 する。**その一覧から実名を選んで `.env` の
`MAIN_MODEL` / `JUDGE_MODEL` を書き換えてから再実行**すること。

推測でモデル名を埋めることは意図的に避けている（間違った「正解」を
ハードコードするより、実際のキーに聞くほうが確実なため）。

## 実測して確かめたいこと

1. **初トークンまでのレイテンシ** — preflight が実測して表示する。
   先行投機実行は「初トークンが猶予ウィンドウ2秒内に返る」ことを暗黙の
   前提にしているので、超えていれば `GRACE_WINDOW_MS` の見直しが要る。
2. **判定往復の実測値** — 下の「2経路」の分岐点そのもの。
3. **judgeModel が `response_format: json_object` に対応しているか** —
   非対応なら判定は毎回「継続なし」に倒れ、中断機構が死ぬ。
   preflight がパース失敗時に警告を出す。
4. **S3 が本当に `interrupt` 経路を通るか** — 実APIの応答長次第では
   `newRound` に落ちる。落ちた場合、失敗ではなく後述の設計判断の材料。

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

## 未決の設計判断（実測後に決めたい）

### 1. 追加発話が通る2経路

判定LLMの往復時間と本体応答の残り長さの大小で分岐する。

```
判定が返った時点で……
  まだ喋っている   → interrupt : 文を言い切ってから破棄し、次ラウンドへ
  もう喋り終わった → newRound  : 中断するものが無いので、そのまま次ラウンド
```

**判定往復が短い応答の全長を上回るのは珍しくない。** システムプロンプトが
「短く簡潔に」と指示しているぶん応答が短いため、実運用では `newRound` 経路
のほうが多く通る可能性が高い。グレースフル中断は長い応答でのみ効く機構。
実測値次第では、判定を軽量化するか、そもそも中断機構の位置づけを見直す。

### 2. `GRACE_WINDOW_MS` が実質機能していない

猶予タイマーは張られるが、追加発話は PROCESSING 中ならいつでも判定に
かけられており、2秒の窓が何かをゲートしているわけではない。

- 窓で絞る（＝窓を過ぎた発話は無視）のか
- 「応答中はいつでも割り込める」を正とする（＝タイマーを消す）のか

**挙動を変える判断になるため、PoCでは既存挙動のまま据え置いている。**

## ファイルの見取り図（今回追加分）

```
src/config.ts           .env読み込みと構成表示（課金事故の予防）
src/preflight.ts        認証・モデル名実在確認・レイテンシ実測
src/scenarioRunner.ts   シナリオ定義と実行（real / fake で共用）
src/realScenarios.ts    実APIエントリ
src/llm/errors.ts       中断エラー判定（SDK差異の吸収）
test/fakeOpenAIServer.ts  OpenAI互換フェイクサーバ（SSE・切断検知つき）
test/runAgainstFake.ts    フェイクサーバ統合テスト
test/serveFake.ts         フェイクサーバ単体起動
```

シナリオランナーは固定sleepではなく**「N文目が完成した瞬間」をトリガに
追加発話を注入する**。手入力やsleepだと割り込みタイミングが応答速度に
依存して再現しないため。
