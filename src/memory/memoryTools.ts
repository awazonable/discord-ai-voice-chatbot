import type { ToolConfig, ToolDefinition } from "../llm/types.js";
import type { LongTermMemory } from "./longTermMemory.js";

/**
 * 長期記憶をLLMのツール呼び出し経由で操作するための定義。
 * overall-design.md の想定ツール名 (save_memory / search_memory) を踏襲。
 */
const SAVE_MEMORY: ToolDefinition = {
  name: "save_memory",
  description:
    "長期記憶として覚えておくべき情報を保存する。ユーザーの好み・予定・重要な" +
    "事実など、今後の会話でも参照する価値があると判断したものだけを保存すること。" +
    "世間話や一時的なやりとりは保存しない。",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "保存する内容。第三者が読んでも文脈がわかるよう簡潔な文で書く。",
      },
      category: {
        type: "string",
        enum: ["preference", "fact", "event", "other"],
        description:
          "preference=好み・嗜好, fact=属性等の事実, event=予定・出来事, other=その他",
      },
      importance: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description: "重要度(1=些細, 5=非常に重要)。誕生日等の恒久的な情報は高め。",
      },
    },
    required: ["text"],
  },
};

const SEARCH_MEMORY: ToolDefinition = {
  name: "search_memory",
  description:
    "過去に保存した長期記憶の中から、現在の会話に関連しそうなものを検索する。" +
    "ユーザーの過去の発言・好み・予定などを思い出す必要があるときに使う。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "検索したい内容の自然文" },
      category: {
        type: "string",
        enum: ["preference", "fact", "event", "other"],
        description: "カテゴリで絞り込みたい場合のみ指定",
      },
    },
    required: ["query"],
  },
};

interface SaveArgs {
  text: string;
  category?: "preference" | "fact" | "event" | "other";
  importance?: number;
}
interface SearchArgs {
  query: string;
  category?: "preference" | "fact" | "event" | "other";
}

/** LongTermMemory実装をLLMのツール呼び出しに繋ぎ込む。 */
export function createMemoryToolConfig(memory: LongTermMemory): ToolConfig {
  return {
    definitions: [SAVE_MEMORY, SEARCH_MEMORY],
    onCall: async (name, argsJson) => {
      if (name === "save_memory") {
        const args = JSON.parse(argsJson) as SaveArgs;
        const rec = await memory.save(args.text, {
          category: args.category,
          importance: args.importance,
        });
        return `保存しました: "${rec.text}" (category=${rec.category}, importance=${rec.importance})`;
      }

      if (name === "search_memory") {
        const args = JSON.parse(argsJson) as SearchArgs;
        const results = await memory.search(args.query, {
          topK: 5,
          category: args.category,
        });
        if (results.length === 0) return "関連する記憶は見つかりませんでした。";
        return results
          .map((r) => `- ${r.text} (category=${r.category}, 関連度=${r.score.toFixed(2)})`)
          .join("\n");
      }

      throw new Error(`未知のツール: ${name}`);
    },
  };
}
