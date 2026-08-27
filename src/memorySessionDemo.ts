import { OpenAILLMClient } from "./llm/openaiClient.js";
import { ZundamonSession } from "./session/zundamonSession.js";
import { EmbeddingClient } from "./memory/embeddings.js";
import { LongTermMemory } from "./memory/longTermMemory.js";
import { createMemoryToolConfig } from "./memory/memoryTools.js";
import { loadConfig, describeConfig } from "./config.js";
import type { Utterance } from "./session/types.js";

/**
 * トークンの4分類（システムプロンプト/現在の問いかけ/短期記憶/長期記憶）を
 * 実際の ZundamonSession に統合した通しデモ。
 *   - 短期記憶: 会話ログが一定件数を超えたら自動で要約に圧縮される
 *     (compactMemory, inputへ差し込み)
 *   - 長期記憶: save_memory/search_memoryツール経由でQdrantに保存・検索
 * 何度も「ずんだもん、〜」で話しかけ、会話を積み重ねて圧縮を発生させ、
 * 最後に長期記憶からの想起を確認する。
 */

function utt(text: string): Utterance {
  return { text, speakerId: "memory-demo", timestamp: Date.now() };
}

function waitForIdle(session: ZundamonSession): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (session.getState() === "IDLE") resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

async function main() {
  const cfg = loadConfig();
  console.log("=== 記憶(短期+長期)統合デモ ===");
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
    collection: "zundamon_memory_session_demo",
  });
  const tools = createMemoryToolConfig(memory);

  let compactedCount = 0;
  let toolCallCount = 0;

  const session = new ZundamonSession(
    llm,
    {
      onPrimaryResponsePlay: (p) => console.log(`[一次応答] ${p}`),
      onSentenceReady: (s) => console.log(`  [文] ${s}`),
      onSpeechInterrupted: (r) => console.log(`[中断要求] ${r}`),
      onFinalResponse: (t) => console.log(`[最終応答] ${t}`),
      onStateChange: (st) => console.log(`(state -> ${st})`),
      onError: (err, ctx) => console.error(`[エラー: ${ctx}]`, err),
      onMemoryCompacted: (summary, facts) => {
        compactedCount++;
        console.log(`\n>>> [短期記憶を圧縮] 要約="${summary}"`);
        console.log(`>>> 抽出された事実: ${facts.join(" / ") || "(なし)"}\n`);
      },
    },
    {
      definitions: tools.definitions,
      onCall: async (name, argsJson) => {
        toolCallCount++;
        console.log(`  >>> [ツール呼び出し] ${name}(${argsJson})`);
        const result = await tools.onCall(name, argsJson);
        console.log(`  >>> [ツール結果] ${result}`);
        return result;
      },
    }
  );

  const turns = [
    "ずんだもん、こんにちは",
    "ずんだもん、私の好きな食べ物はずんだ餅だよ。覚えておいて。",
    "ずんだもん、今日はいい天気だね",
    "ずんだもん、明日も晴れるといいな",
    "ずんだもん、最近面白い本を読んだ？",
    "ずんだもん、そういえば運動の話をしよう",
  ];

  for (const [i, text] of turns.entries()) {
    console.log(`\n--- ターン${i + 1}: "${text}" ---`);
    await session.onFinalUtterance(utt(text));
    await waitForIdle(session);
  }

  console.log(`\n[圧縮が${compactedCount}回発生。ここで短期記憶に載っているはず]`);
  console.log("\n--- 想起テスト: 「私の好きな食べ物は何だっけ？」 ---");
  await session.onFinalUtterance(utt("ずんだもん、私の好きな食べ物は何だっけ？"));
  await waitForIdle(session);

  console.log(`\n=== 結果 ===`);
  console.log(`  短期記憶の圧縮回数: ${compactedCount}`);
  console.log(`  ツール呼び出し回数: ${toolCallCount}`);
}

main().catch((err) => {
  console.error("✗ デモの実行に失敗しました:", err);
  process.exit(1);
});
