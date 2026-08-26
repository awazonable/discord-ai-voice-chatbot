import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { OpenAILLMClient } from "./llm/openaiClient.js";
import { ZundamonSession } from "./session/zundamonSession.js";
import { loadConfig, describeConfig, MissingApiKeyError } from "./config.js";
import type { Utterance } from "./session/types.js";

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof MissingApiKeyError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

console.log("実APIに接続します:");
console.log(describeConfig(cfg));
console.log();

const llm = new OpenAILLMClient({
  apiKey: cfg.apiKey,
  mainModel: cfg.mainModel,
  judgeModel: cfg.judgeModel,
  baseURL: cfg.baseURL,
});

const session = new ZundamonSession(llm, {
  onPrimaryResponsePlay: (phrase) => console.log(`\n[一次応答] ${phrase}`),
  onSentenceReady: (sentence) =>
    console.log(`[文完成→VOICEVOXキュー] ${sentence}`),
  onSpeechInterrupted: (reason) => console.log(`[中断要求] ${reason}`),
  onFinalResponse: (text) => console.log(`[最終応答確定] ${text}\n`),
  onStateChange: (state) => console.log(`(state -> ${state})`),
  onError: (err, context) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[エラー: ${context}] ${msg}`);
    console.error("  モデル名が正しいかは `npm run preflight` で確認できます。\n");
  },
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
