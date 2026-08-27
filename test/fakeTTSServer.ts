import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * su-shiki(Web版VOICEVOX API)互換の最小フェイクサーバ。
 *
 * 実APIでは再現しづらい・課金がかさむ異常系（ステータス異常・不正JSON・
 * 「200だが音声ではない」等）を無料かつ確実に再現し、SushikiTTSClientの
 * エラーハンドリングを検証するために使う。test/fakeOpenAIServer.ts と
 * 同じ発想。
 */

export type AudioMode =
  | "ok"
  | "http500"
  /** 200だが本文がJSON等でaudio/*ではない。notEnoughPoints等の実運用エラーを模擬。 */
  | "errorBody200";

export type SpeakersMode =
  | "ok"
  | "http500"
  | "malformedJson"
  /** 200 + 正当なJSONだが配列ではない形（想定外のスキーマ変更を模擬）。 */
  | "notArray";

export interface FakeTTSServerOptions {
  audioMode?: AudioMode;
  speakersMode?: SpeakersMode;
  port?: number;
}

export interface FakeTTSServer {
  baseURL: string;
  close: () => Promise<void>;
}

// 中身は本物のWAVでなくてよい（クライアントはContent-Typeで判定するため）。
const FAKE_AUDIO_BYTES = Buffer.from("RIFF-fake-wav-body");

export async function startFakeTTSServer(
  opts: FakeTTSServerOptions = {}
): Promise<FakeTTSServer> {
  const audioMode = opts.audioMode ?? "ok";
  const speakersMode = opts.speakersMode ?? "ok";

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/v2/voicevox/audio")) {
      if (audioMode === "http500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal server error (fake)");
        return;
      }
      if (audioMode === "errorBody200") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "notEnoughPoints (fake)" }));
        return;
      }
      res.writeHead(200, { "content-type": "audio/x-wav" });
      res.end(FAKE_AUDIO_BYTES);
      return;
    }

    if (req.url?.startsWith("/v2/voicevox/speakers")) {
      if (speakersMode === "http500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal server error (fake)");
        return;
      }
      if (speakersMode === "malformedJson") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not valid json");
        return;
      }
      if (speakersMode === "notArray") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalidApiKey (fake)" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { name: "ずんだもん", styles: [{ name: "ノーマル", id: 3 }] },
        ])
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`no route for ${req.url}`);
  });

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, "127.0.0.1", resolve)
  );
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      ),
  };
}
