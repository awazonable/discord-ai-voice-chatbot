import { startFakeServer } from "./fakeOpenAIServer.js";

/**
 * フェイクOpenAI互換サーバを単体で起動する。
 *
 *   npx tsx test/serveFake.ts
 *   # 別ターミナルで
 *   OPENAI_API_KEY=dummy OPENAI_BASE_URL=http://127.0.0.1:8787/v1 \
 *     MAIN_MODEL=fake-main JUDGE_MODEL=fake-judge npm run preflight
 *
 * APIキーを使わずに preflight / scenarios:real の動作を確認できる。
 */
const port = Number(process.env.FAKE_PORT ?? 8787);
const server = await startFakeServer({
  tokenDelayMs: Number(process.env.FAKE_TOKEN_DELAY_MS ?? 60),
  judgeLatencyMs: Number(process.env.FAKE_JUDGE_LATENCY_MS ?? 600),
  port,
});
console.log(`fake OpenAI-compatible server: ${server.baseURL}`);
console.log("  MAIN_MODEL=fake-main JUDGE_MODEL=fake-judge");
console.log("Ctrl+C で停止");
