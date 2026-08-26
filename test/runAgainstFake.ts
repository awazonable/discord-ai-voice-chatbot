import {
  startFakeServer,
  FAKE_MAIN_MODEL,
  FAKE_JUDGE_MODEL,
} from "./fakeOpenAIServer.js";
import { OpenAILLMClient } from "../src/llm/openaiClient.js";
import { runAllScenarios } from "../src/scenarioRunner.js";
import { parseJudgeResponse } from "../src/llm/openaiClient.js";

/**
 * APIキー無しで「実API経路」を検証する。
 *
 * realScenarios.ts と同じ runAllScenarios / OpenAILLMClient を使い、
 * 向き先だけをローカルのOpenAI互換フェイクサーバに差し替える。
 * つまり openai SDK・SSEパース・AbortSignalによる切断まで含めて
 * 本番と同じコードが動く。
 */

function check(name: string, cond: boolean, detail = ""): boolean {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return cond;
}

async function main() {
  // --- 判定応答パーサの単体チェック（実APIの出力揺れ対策） -------------
  console.log("=".repeat(70));
  console.log("判定応答パーサ (parseJudgeResponse)");
  console.log("=".repeat(70));
  const parserChecks = [
    check(
      "素のJSON",
      parseJudgeResponse('{"is_continuation":true,"reasoning":"r"}')
        .isContinuation === true
    ),
    check(
      "```json フェンス付き",
      parseJudgeResponse('```json\n{"is_continuation":true,"reasoning":"r"}\n```')
        .isContinuation === true
    ),
    check(
      "前置き付き",
      parseJudgeResponse('判定します: {"is_continuation":true,"reasoning":"r"}')
        .isContinuation === true
    ),
    check(
      "壊れた応答は継続なしに倒れる（例外を投げない）",
      parseJudgeResponse("すみません、判定できません").isContinuation === false
    ),
  ];

  // --- フェイクサーバに対する統合シナリオ ------------------------------
  // 実APIのレイテンシ感を模擬する: トークン間隔60ms、判定往復600ms。
  const server = await startFakeServer({ tokenDelayMs: 60, judgeLatencyMs: 600 });
  console.log(`\nフェイクOpenAI互換サーバ起動: ${server.baseURL}\n`);

  const llm = new OpenAILLMClient({
    apiKey: "sk-fake-not-a-real-key",
    mainModel: FAKE_MAIN_MODEL,
    judgeModel: FAKE_JUDGE_MODEL,
    baseURL: server.baseURL,
  });

  const failed = await runAllScenarios(llm);

  // --- 中断が実際にHTTPストリームを切っているかを確認 -------------------
  console.log("\n" + "=".repeat(70));
  console.log("サーバ側から見た挙動");
  console.log("=".repeat(70));
  console.log(`  ストリーム要求: ${server.stats.streamRequests}`);
  console.log(`  判定要求      : ${server.stats.judgeRequests}`);
  console.log(`  完走した応答  : ${server.stats.completedStreams}`);
  console.log(`  切断された応答: ${server.stats.abortedStreams}`);
  console.log();

  const abortWorks = check(
    "グレースフル中断でHTTPストリームが実際に切断される（課金の垂れ流し防止）",
    server.stats.abortedStreams >= 1,
    `abortedStreams=${server.stats.abortedStreams}`
  );

  await server.close();

  const allOk = failed === 0 && abortWorks && parserChecks.every(Boolean);
  console.log(`\n総合: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
