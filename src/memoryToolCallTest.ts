import { OpenAILLMClient } from "./llm/openaiClient.js";
import { EmbeddingClient } from "./memory/embeddings.js";
import { LongTermMemory } from "./memory/longTermMemory.js";
import { createMemoryToolConfig } from "./memory/memoryTools.js";
import { loadConfig, describeConfig } from "./config.js";
import type { ChatMessage } from "./llm/types.js";

/**
 * 長期記憶(save_memory/search_memory)をLLMのツール呼び出し経由で
 * 実際に使わせる統合テスト。2ラウンド構成:
 *   1. 「覚えておいて」と頼む -> save_memoryが呼ばれるはず
 *   2. （会話履歴を持たない新規ラウンドとして）「何だっけ？」と聞く
 *      -> search_memoryが呼ばれ、正しく思い出せるはず
 */

const SYSTEM_PROMPT: ChatMessage = {
  role: "system",
  content:
    "あなたはずんだもんです。「〜のだ」口調で話します。" +
    "ユーザーについて覚えておくべき情報（好み・予定・重要な事実）が出てきたら" +
    "必ず save_memory で保存すること。" +
    "ユーザーの過去の発言・好み・予定について聞かれたときは、" +
    "自分の記憶を信用せず、答える前に必ず search_memory を1回呼び出してから" +
    "答えること。呼び出す前に「知らない」「覚えていない」と結論づけては" +
    "いけない。検索しても見つからなかった場合のみ、その旨を伝えてよい。",
};

async function runToCompletion(
  llm: OpenAILLMClient,
  messages: ChatMessage[],
  tools: ReturnType<typeof createMemoryToolConfig>
): Promise<string> {
  const ctrl = new AbortController();
  let text = "";
  for await (const tok of llm.streamChat(messages, ctrl.signal, tools)) {
    text += tok.text;
  }
  return text;
}

async function main() {
  const cfg = loadConfig();
  console.log("=== 長期記憶ツールコール統合テスト ===");
  console.log(describeConfig(cfg));
  console.log(`  qdrant: ${cfg.qdrantURL}\n`);

  const llm = new OpenAILLMClient({
    apiKey: cfg.apiKey,
    mainModel: cfg.mainModel,
    judgeModel: cfg.judgeModel,
    baseURL: cfg.baseURL,
  });

  const embeddings = new EmbeddingClient({ apiKey: cfg.apiKey, model: cfg.embeddingModel });
  const memory = new LongTermMemory({
    qdrantURL: cfg.qdrantURL,
    embeddings,
    collection: "zundamon_memory_tooltest",
  });

  let saveCalled = false;
  let searchCalled = false;
  const baseTools = createMemoryToolConfig(memory);
  const tools = {
    definitions: baseTools.definitions,
    onCall: async (name: string, argsJson: string) => {
      if (name === "save_memory") saveCalled = true;
      if (name === "search_memory") searchCalled = true;
      console.log(`  [ツール呼び出し] ${name}(${argsJson})`);
      const result = await baseTools.onCall(name, argsJson);
      console.log(`  [ツール結果] ${result}`);
      return result;
    },
  };

  console.log("--- ラウンド1: 覚えてもらう ---");
  const round1Text = await runToCompletion(
    llm,
    [
      SYSTEM_PROMPT,
      { role: "user", content: "ずんだもん、私の好きな食べ物はずんだ餅だよ。覚えておいて。" },
    ],
    tools
  );
  console.log(`  応答: ${round1Text}\n`);

  console.log("--- ラウンド2: 新規ラウンドとして思い出してもらう ---");
  const round2Text = await runToCompletion(
    llm,
    [SYSTEM_PROMPT, { role: "user", content: "ずんだもん、私の好きな食べ物は何だっけ？" }],
    tools
  );
  console.log(`  応答: ${round2Text}\n`);

  console.log("=== 結果 ===");
  console.log(`  save_memoryが呼ばれた  : ${saveCalled}`);
  console.log(`  search_memoryが呼ばれた: ${searchCalled}`);
  console.log(`  応答に「ずんだ餅」を含む: ${round2Text.includes("ずんだ餅")}`);

  const ok = saveCalled && searchCalled && round2Text.includes("ずんだ餅");
  console.log(`\n${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ テストに失敗しました:", err);
  process.exit(1);
});
