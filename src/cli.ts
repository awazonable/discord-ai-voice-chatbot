import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { OpenAILLMClient } from "./llm/openaiClient.js";
import { ZundamonSession } from "./session/zundamonSession.js";
import type { Utterance } from "./session/types.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("環境変数 OPENAI_API_KEY を設定してください");
  process.exit(1);
}

// モデル名は仮。docs.claude.com ではなく OpenAI 側の実際のモデル名に
// 合わせて調整してください（例: "gpt-5.6-sol", "gpt-5.6-luna" 等）。
const MAIN_MODEL = process.env.MAIN_MODEL ?? "gpt-5.6-sol";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gpt-5.6-luna";

const llm = new OpenAILLMClient(apiKey, MAIN_MODEL, JUDGE_MODEL);

const session = new ZundamonSession(llm, {
  onPrimaryResponsePlay: (phrase) => console.log(`\n[一次応答] ${phrase}`),
  onSentenceReady: (sentence) =>
    console.log(`[文完成→VOICEVOXキュー] ${sentence}`),
  onSpeechInterrupted: (reason) => console.log(`[中断要求] ${reason}`),
  onFinalResponse: (text) => console.log(`[最終応答確定] ${text}\n`),
  onStateChange: (state) => console.log(`(state -> ${state})`),
});

// このPoCでは実際の音声認識(hayamimi/sherpa-onnx-node)の代わりに
// キーボード入力を「VADのfinal確定テキスト」として扱う。
// 1行入力するたびに onFinalUtterance を呼ぶことで、
// 「文が複数回に分かれて届く」状況(=追加発話)を手動で再現できる。
//
// 使い方の例:
//   > ずんだもん、明日の天気は？
//   （応答生成中に、すかさず次の行を入力すると追加発話として扱われる）
//   > やっぱりいいや、明日の予定について聞きたい

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(
    "テキストでVAD final確定を模擬します。「ずんだもん」を含む行で起動します。\n" +
      "Ctrl+C で終了。\n"
  );

  while (true) {
    const line = await rl.question("> ");
    if (!line.trim()) continue;

    const utt: Utterance = {
      text: line.trim(),
      speakerId: "cli-user",
      timestamp: Date.now(),
    };

    // awaitしない: 応答生成中でも次の入力(追加発話)を受け付けるため
    session.onFinalUtterance(utt).catch((e) => console.error(e));
  }
}

main();
