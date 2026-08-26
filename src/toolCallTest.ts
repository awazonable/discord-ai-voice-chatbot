import OpenAI from "openai";
import { loadConfig, describeConfig } from "./config.js";

/**
 * ツールコール（function calling）がこのAPI/モデルで動くかを見るだけの
 * 軽量な単発テスト。本体のセッションロジックには組み込まない。
 * ダミーの「検索」関数を1つ渡して、モデルが呼び出しを選ぶか・
 * その結果を受けて最終応答を作れるかを確認する。
 */

const searchTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Web検索を行い、関連する情報のスニペットを返す。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索クエリ" },
      },
      required: ["query"],
    },
  },
};

/** 実際には検索しない。呼ばれたことと引数が見えればよいのでダミー結果を返す。 */
function fakeWebSearch(query: string): string {
  return `[ダミー検索結果] "${query}" に関する情報は見つかりませんでした（これはテスト用のダミー応答です）。`;
}

async function main() {
  const cfg = loadConfig();
  console.log("=== ツールコール疎通テスト ===");
  console.log(describeConfig(cfg));
  console.log();

  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "あなたはずんだもんです。「〜のだ」口調で話します。最新情報が必要な質問には web_search ツールを使ってください。",
    },
    {
      role: "user",
      content: "ずんだもん、今日の東京の天気を検索して教えて。",
    },
  ];

  console.log(`[1回目の呼び出し] model=${cfg.mainModel}`);
  const first = await client.chat.completions.create({
    model: cfg.mainModel,
    messages,
    tools: [searchTool],
    // gpt-5.6系はreasoningモデルで、reasoning_effortが立っていると
    // /v1/chat/completions 経由のfunction toolsを拒否する(400)。
    // 疎通確認だけが目的なので 'none' にして無効化する。
    reasoning_effort: "none",
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

  const choice = first.choices[0];
  const toolCalls = choice?.message.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    console.log("✗ モデルはツールを呼びませんでした。");
    console.log(`  応答: ${JSON.stringify(choice?.message.content)}`);
    console.log(`  finish_reason: ${choice?.finish_reason}`);
    return;
  }

  console.log(`✓ ツール呼び出しを検出: ${toolCalls.length}件`);
  for (const call of toolCalls) {
    if (call.type === "function") {
      console.log(`    - ${call.function.name}(${call.function.arguments})`);
    }
  }

  // ツール結果を返して最終応答を取得（往復できるかも確認する）
  messages.push(choice.message);
  for (const call of toolCalls) {
    if (call.type !== "function") continue;
    const args = JSON.parse(call.function.arguments) as { query: string };
    const result = fakeWebSearch(args.query);
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: result,
    });
  }

  console.log(`\n[2回目の呼び出し] ツール結果を渡して最終応答を取得`);
  const second = await client.chat.completions.create({
    model: cfg.mainModel,
    messages,
    tools: [searchTool],
    reasoning_effort: "none",
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

  console.log(`✓ 最終応答: ${second.choices[0]?.message.content}`);
  console.log("\n=== ツールコール疎通テスト成功 ===");
}

main().catch((err) => {
  console.error("✗ ツールコールテストに失敗しました:");
  console.error(err);
  process.exit(1);
});
