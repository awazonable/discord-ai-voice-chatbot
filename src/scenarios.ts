import { MockLLMClient } from "./llm/mockClient.js";
import { ZundamonSession } from "./session/zundamonSession.js";
import type { Utterance } from "./session/types.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSession(label: string, tokenDelayMs = 150) {
  const llm = new MockLLMClient(tokenDelayMs);
  const session = new ZundamonSession(llm, {
    onPrimaryResponsePlay: (phrase) =>
      console.log(`[${label}] 一次応答再生: "${phrase}"`),
    onSentenceReady: (sentence) =>
      console.log(`[${label}] 文完成 -> VOICEVOXキュー投入: "${sentence}"`),
    onSpeechInterrupted: (reason) =>
      console.log(`[${label}] 中断要求: ${reason}`),
    onFinalResponse: (text) =>
      console.log(`[${label}] 最終応答確定: "${text}"`),
    onStateChange: (state) => console.log(`[${label}] state -> ${state}`),
  });
  return session;
}

function utt(text: string, speakerId = "user1"): Utterance {
  return { text, speakerId, timestamp: Date.now() };
}

async function scenario5_relevantFollowupMidStream() {
  console.log(
    "\n=== シナリオ5: 再生中に関連する追加発話 -> 文単位グレースフル中断 ==="
  );
  const session = makeSession("S5", 150);
  // 長めの応答を誘発する語彙は mockClient 側にないため、
  // ここでは複数文になるよう mock の応答文を意識しつつ間隔を調整
  await session.onFinalUtterance(utt("明日遠足だわー。ずんだもん、、、"));
  await sleep(200); // 1文目が完成する前後で割り込む
  await session.onFinalUtterance(utt("明日の天気は？"));
  await sleep(3000);
}

async function scenario4_irrelevantFollowup() {
  console.log(
    "\n=== シナリオ4: 無関係な追加発話は無視され、応答はそのまま最後まで ==="
  );
  const session = makeSession("S4");
  await session.onFinalUtterance(utt("明日の天気わかる？ずんだもん。"));
  await sleep(300);
  await session.onFinalUtterance(utt("この応答あったら明日の計画立てようぜ"));
  await sleep(2500);
}

async function main() {
  await scenario4_irrelevantFollowup();
  await scenario5_relevantFollowupMidStream();
}

main().catch(console.error);
