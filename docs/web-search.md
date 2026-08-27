# Web検索

## 方針

Web検索は本体LLMから分離し、実行環境の`SearchProvider`として扱う。
本体モデルをOpenAIからローカルLLMへ変更しても、同じ`web_search`ツールを
使い続けられる構成にする。

現在のプロバイダーは次の3種類。

- `searxng`: 既定。ローカルまたは管理下のSearXNGへ問い合わせる
- `openai`: OpenAI Responses APIの組み込みWeb Searchを使う任意経路
- `mock`: ネットワークを使わない自動試験用

Discordボットから見えるツール名と結果形式はプロバイダーに依存しない。
将来MCPサーバーへ分離する場合も、この境界の外側だけをMCP transportへ
置き換える。初版では同一プロセス内で十分なためMCPサーバーは立てない。

## SearXNGの準備

SearXNGは公式コンテナのローカル開発用最小構成を`infra/searxng/`に用意している。
ポートは`127.0.0.1`だけへ公開し、JSON APIとSafeSearchを有効にしている。
基礎となる構成はSearXNGの
[公式コンテナ手順](https://docs.searxng.org/admin/installation-docker.html)に準拠する。

```bash
npm run search:up
npm run search:smoke -- OpenAI
```

停止する場合は`npm run search:down`。設定を自分で用意する場合は、外部公開せず
原則として`127.0.0.1`へバインドする。JSON APIを使うため、SearXNGの
`settings.yml`で`search.formats`に`json`を追加する。

```yaml
search:
  formats:
    - html
    - json
```

ボット側は次の設定で接続する。

```dotenv
WEB_SEARCH_BACKEND=searxng
SEARXNG_URL=http://127.0.0.1:8080
```

`http://127.0.0.1:8080/search?q=test&format=json`がJSONを返せば準備完了。
SearXNGを使わず従来どおり起動する場合は`WEB_SEARCH_BACKEND=disabled`にする。
検索パラメーターの仕様は
[SearXNG Search API](https://docs.searxng.org/dev/search_api.html)を参照。

## OpenAI組み込み検索への切り替え

```dotenv
WEB_SEARCH_BACKEND=openai
# 省略時はMAIN_MODEL
WEB_SEARCH_MODEL=gpt-5.6-luna
```

この経路だけResponses APIのWeb Searchを使う。レスポンスは共通の検索結果形式へ
正規化されるため、Discordボットやセッション層はOpenAI固有型に依存しない。

## 安全上の境界

- SearXNGへの`safeSearch=2`はボット側で固定し、モデル入力から変更できない
- モデルが指定できるのは検索語・言語・期間だけ
- 一度に返す件数、検索語、タイトル、URL、抜粋、応答サイズに上限を設ける
- 初版は検索結果の抜粋だけを返し、結果URLの本文を自動取得しない
- 検索結果は信頼できない外部入力として扱い、結果内の指示には従わない
- タイムアウトや検索失敗時は推測で補完せず、ツールエラーとしてモデルへ返す

SafeSearchは検索エンジン側の対応範囲に依存するため、完全な内容保証ではない。
公開運用時はSearXNG自体のアクセス制限、利用エンジン、レート制限、ログ保持も
別途設定する。
