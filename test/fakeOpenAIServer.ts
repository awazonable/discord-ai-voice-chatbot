import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * OpenAI互換の最小フェイクサーバ。
 *
 * APIキー無しでも `OpenAILLMClient` の実コード（openai SDK・SSEパース・
 * AbortSignalによる中断）をHTTP越しにそのまま検証するために使う。
 * モックLLM(mockClient)はSDKを通らないので、実API固有の経路
 * （SSEのdelta形式、finish_reason、中断時の切断）はここでしか確認できない。
 */

export const FAKE_MAIN_MODEL = "fake-main";
export const FAKE_JUDGE_MODEL = "fake-judge";

/** 追加発話が「呼びかけの続き」とみなされる語 */
const CONTINUATION_MARKERS = ["やっぱり", "ついでに", "それと", "あと"];
/** 継続のうち「今の話を打ち切りたい」とみなされる語（それ以外は追加要求として扱う） */
const ABANDON_MARKERS = ["やっぱり"];

const RESPONSES: Array<[RegExp, string]> = [
  // 判定往復(既定600ms)より長く喋り続ける応答。グレースフル中断の経路を
  // 確実に通すために、意図的に多数の文からなる長い応答を返す。
  [
    /長い話|10個|ひとつずつ/,
    "遠足の持ち物を説明するのだ。" +
      "一つ目はお弁当なのだ。二つ目は水筒なのだ。三つ目はおやつなのだ。" +
      "四つ目はレジャーシートなのだ。五つ目は雨具なのだ。六つ目は帽子なのだ。" +
      "七つ目はタオルなのだ。八つ目はティッシュなのだ。九つ目は絆創膏なのだ。" +
      "十個目はしおりなのだ。これで準備は万全なのだ。",
  ],
  [/天気/, "天気を調べたのだ。明日は晴れなのだ。傘はいらないのだ。よい一日なのだ。"],
  [/遠足|持ち物/, "遠足の持ち物なのだ。お弁当と水筒が必要なのだ。雨具もあると安心なのだ。"],
  [/自己紹介/, "ぼくはずんだもんなのだ。ずんだ餅の妖精なのだ。よろしくなのだ。"],
];
const DEFAULT_RESPONSE = "こんにちはなのだ。何か用なのだ。";

export interface FakeServerStats {
  streamRequests: number;
  judgeRequests: number;
  /** クライアント切断でストリーム送出を中断した回数（＝中断が効いた回数） */
  abortedStreams: number;
  completedStreams: number;
}

export interface FakeServer {
  baseURL: string;
  stats: FakeServerStats;
  close: () => Promise<void>;
}

function pickResponse(userText: string): string {
  for (const [re, text] of RESPONSES) {
    if (re.test(userText)) return text;
  }
  return DEFAULT_RESPONSE;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FakeServerOptions {
  /** 1トークンあたりの送出間隔。実APIのストリーミング速度の模擬。 */
  tokenDelayMs?: number;
  /** 判定呼び出しの模擬レイテンシ。実APIでは数百ms〜数秒かかる。 */
  judgeLatencyMs?: number;
  /** 固定ポートで待ち受ける。既定は 0（空きポート自動割当）。 */
  port?: number;
}

export async function startFakeServer(
  opts: FakeServerOptions = {}
): Promise<FakeServer> {
  const tokenDelayMs = opts.tokenDelayMs ?? 60;
  const judgeLatencyMs = opts.judgeLatencyMs ?? 600;

  const stats: FakeServerStats = {
    streamRequests: 0,
    judgeRequests: 0,
    abortedStreams: 0,
    completedStreams: 0,
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [FAKE_MAIN_MODEL, FAKE_JUDGE_MODEL].map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "fake",
          })),
        })
      );
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      const body = JSON.parse(await readBody(req)) as {
        stream?: boolean;
        messages: Array<{ role: string; content: string }>;
        response_format?: { type: string };
      };

      const lastUser = [...body.messages]
        .reverse()
        .find((m) => m.role === "user");
      const userText = lastUser?.content ?? "";

      // --- 判定呼び出し（非ストリーミング + json_object） ---
      if (!body.stream) {
        stats.judgeRequests++;
        // 実APIの判定レイテンシを模擬する。これが無いと
        // 「判定中にラウンドが完走する」競合が再現できない。
        await sleep(judgeLatencyMs);
        const isContinuation = CONTINUATION_MARKERS.some((m) =>
          userText.includes(m)
        );
        const abandonsCurrent =
          isContinuation && ABANDON_MARKERS.some((m) => userText.includes(m));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fake-judge-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: FAKE_JUDGE_MODEL,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    is_continuation: isContinuation,
                    abandons_current: abandonsCurrent,
                    reasoning: isContinuation
                      ? "呼びかけの言い直し・追加要求とみなした(fake)"
                      : "別話題の発話とみなした(fake)",
                  }),
                },
                finish_reason: "stop",
              },
            ],
          })
        );
        return;
      }

      // --- 本体ストリーミング（SSE） ---
      stats.streamRequests++;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // クライアント切断の検知。中断が本当にHTTP接続を切っているかを
      // サーバ側から観測するための要。res 側の close も拾わないと、
      // fetch の abort による切断を取りこぼす。
      let clientGone = false;
      let finished = false;
      const markGone = () => {
        if (!finished) clientGone = true;
      };
      req.on("close", markGone);
      res.on("close", markGone);

      const text = pickResponse(userText);
      const tokens = text.match(/.{1,4}/g) ?? [];

      for (const t of tokens) {
        if (clientGone) {
          stats.abortedStreams++;
          res.destroy();
          return;
        }
        await sleep(tokenDelayMs);
        res.write(
          `data: ${JSON.stringify({
            id: "fake-chunk",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: FAKE_MAIN_MODEL,
            choices: [{ index: 0, delta: { content: t }, finish_reason: null }],
          })}\n\n`
        );
      }

      if (clientGone) {
        stats.abortedStreams++;
        res.destroy();
        return;
      }

      res.write(
        `data: ${JSON.stringify({
          id: "fake-chunk",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: FAKE_MAIN_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      finished = true;
      res.end();
      stats.completedStreams++;
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route for ${req.url}` } }));
  });

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, "127.0.0.1", resolve)
  );
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      ),
  };
}
