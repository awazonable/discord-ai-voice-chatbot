import { startFakeTTSServer } from "./fakeTTSServer.js";
import { SushikiTTSClient, TTSError } from "../src/tts/sushikiClient.js";
import type { AudioMode, SpeakersMode } from "./fakeTTSServer.js";

/**
 * SushikiTTSClient のエラーハンドリングを、フェイクサーバ越しに検証する。
 * 実APIでは再現しづらい/課金がかさむ異常系をここでカバーする。
 */

interface Case {
  name: string;
  run: (client: SushikiTTSClient) => Promise<void>;
  /** trueなら「例外を投げること」を期待、falseなら「例外を投げず正常終了すること」を期待 */
  expectThrow: boolean;
}

const audioCases: Array<{ mode: AudioMode; case: Case }> = [
  {
    mode: "ok",
    case: {
      name: "audio: 正常系は例外を投げない",
      run: async (c) => {
        const r = await c.synthesize("てすと");
        if (!r.contentType.startsWith("audio/")) {
          throw new Error(`content-typeがaudioではない: ${r.contentType}`);
        }
      },
      expectThrow: false,
    },
  },
  {
    mode: "http500",
    case: {
      name: "audio: HTTP 500 は TTSError を投げる",
      run: (c) => c.synthesize("てすと").then(() => {}),
      expectThrow: true,
    },
  },
  {
    mode: "errorBody200",
    case: {
      name: "audio: 200だが本文が音声でない(notEnoughPoints等)場合もTTSErrorを投げる",
      run: (c) => c.synthesize("てすと").then(() => {}),
      expectThrow: true,
    },
  },
];

const speakersCases: Array<{ mode: SpeakersMode; case: Case }> = [
  {
    mode: "ok",
    case: {
      name: "speakers: 正常系は1件以上パースできる",
      run: async (c) => {
        const speakers = await c.listSpeakers();
        if (speakers.length !== 1 || speakers[0]?.name !== "ずんだもん") {
          throw new Error(`期待した話者が取れなかった: ${JSON.stringify(speakers)}`);
        }
      },
      expectThrow: false,
    },
  },
  {
    mode: "http500",
    case: {
      name: "speakers: HTTP 500 は TTSError を投げる",
      run: (c) => c.listSpeakers().then(() => {}),
      expectThrow: true,
    },
  },
  {
    mode: "malformedJson",
    case: {
      name: "speakers: 壊れたJSONは TTSError を投げる",
      run: (c) => c.listSpeakers().then(() => {}),
      expectThrow: true,
    },
  },
  {
    mode: "notArray",
    case: {
      name: "speakers: 配列でない(スキーマ想定外)は例外にせず空配列で返す",
      run: async (c) => {
        const speakers = await c.listSpeakers();
        if (speakers.length !== 0) {
          throw new Error(`空配列を期待したが: ${JSON.stringify(speakers)}`);
        }
      },
      expectThrow: false,
    },
  },
];

async function runCase(
  label: string,
  c: Case,
  makeServer: () => Promise<{ baseURL: string; close: () => Promise<void> }>
): Promise<boolean> {
  const server = await makeServer();
  const client = new SushikiTTSClient({ apiKey: "fake-key", baseURL: server.baseURL });

  let threw = false;
  let error: unknown;
  try {
    await c.run(client);
  } catch (err) {
    threw = true;
    error = err;
  } finally {
    await server.close();
  }

  const ok = threw === c.expectThrow;
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${label}] ${c.name}`);
  if (!ok) {
    console.log(
      `        期待: throw=${c.expectThrow} / 実際: throw=${threw}` +
        (error ? ` (${error instanceof Error ? error.message : error})` : "")
    );
  } else if (threw && !(error instanceof TTSError)) {
    console.log(`        ⚠ 投げた例外がTTSErrorではない: ${error}`);
  }
  return ok;
}

async function main() {
  console.log("=== SushikiTTSClient 異常系テスト(フェイクサーバ) ===\n");

  const results: boolean[] = [];

  for (const { mode, case: c } of audioCases) {
    results.push(
      await runCase("audio", c, () => startFakeTTSServer({ audioMode: mode }))
    );
  }
  for (const { mode, case: c } of speakersCases) {
    results.push(
      await runCase("speakers", c, () =>
        startFakeTTSServer({ speakersMode: mode })
      )
    );
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${results.length - failed}/${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
