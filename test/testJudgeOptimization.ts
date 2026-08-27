import { startFakeServer, FAKE_MAIN_MODEL, FAKE_JUDGE_MODEL } from "./fakeOpenAIServer.js";
import { OpenAILLMClient } from "../src/llm/openaiClient.js";
import { ZundamonSession } from "../src/session/zundamonSession.js";
import type { Utterance } from "../src/session/types.js";

/**
 * 判定コスト最適化(ウェイクワードのみの発話をLLM判定にかけない)の検証。
 * フェイクサーバの判定リクエスト数を見て、実際にLLM呼び出しが
 * 省略されているかを確認する。
 */

function utt(text: string): Utterance {
  return { text, speakerId: "test", timestamp: Date.now() };
}

function waitForIdle(session: ZundamonSession): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (session.getState() === "IDLE") resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

async function main() {
  const server = await startFakeServer({ tokenDelayMs: 20, judgeLatencyMs: 100 });
  const llm = new OpenAILLMClient({
    apiKey: "sk-fake",
    mainModel: FAKE_MAIN_MODEL,
    judgeModel: FAKE_JUDGE_MODEL,
    baseURL: server.baseURL,
  });

  let judgedCalls = 0;
  const session = new ZundamonSession(llm, {
    onPrimaryResponsePlay: () => {},
    onSentenceReady: () => {},
    onSpeechInterrupted: () => {},
    onFinalResponse: () => {},
    onStateChange: () => {},
    onJudge: () => {
      judgedCalls++;
    },
  });

  console.log("=== 判定コスト最適化テスト ===\n");

  console.log("[1] 起動 + ウェイクワードのみの追加発話 -> LLM判定は呼ばれないはず");
  await session.onFinalUtterance(utt("ずんだもん、こんにちは"));
  await waitForIdle(session);
  const judgeReqBefore = server.stats.judgeRequests;

  await session.onFinalUtterance(utt("ずんだもん、こんにちは"));
  await session.onFinalUtterance(utt("ずんだもん")); // ウェイクワードのみ
  await waitForIdle(session);
  await new Promise((r) => setTimeout(r, 300));

  const judgeReqAfterTrivial = server.stats.judgeRequests;
  const trivialOk = judgeReqAfterTrivial === judgeReqBefore;
  console.log(
    `  ${trivialOk ? "PASS" : "FAIL"}  ウェイクワードのみ: 判定リクエスト増分=${
      judgeReqAfterTrivial - judgeReqBefore
    } (期待値0)`
  );

  console.log("\n[2] 通常の追加発話 -> LLM判定は呼ばれるはず(回帰確認)");
  await session.onFinalUtterance(utt("ずんだもん、こんにちは"));
  await session.onFinalUtterance(utt("ずんだもん、明日の天気は？")); // 本題あり
  await waitForIdle(session);
  await new Promise((r) => setTimeout(r, 300));

  const judgeReqAfterNormal = server.stats.judgeRequests;
  const normalOk = judgeReqAfterNormal > judgeReqAfterTrivial;
  console.log(
    `  ${normalOk ? "PASS" : "FAIL"}  通常の発話: 判定リクエスト増分=${
      judgeReqAfterNormal - judgeReqAfterTrivial
    } (期待値>=1)`
  );

  await server.close();

  const allOk = trivialOk && normalOk;
  console.log(`\n${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
