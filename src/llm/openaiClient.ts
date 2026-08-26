import OpenAI from "openai";
import type { ChatMessage, LLMClient, StreamToken } from "./types.js";

/**
 * GPT-5.6 Sol（本体）とGPT-5.6 Luna（判定用軽量モデル）を使う実装。
 * base_urlを差し替えれば将来ローカルQwen3.6-35B-A3B等にも移行できる。
 */
export class OpenAILLMClient implements LLMClient {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private mainModel = "gpt-5.6-sol",
    private judgeModel = "gpt-5.6-luna",
    baseURL?: string
  ) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async *streamChat(
    messages: ChatMessage[],
    signal: AbortSignal
  ): AsyncGenerator<StreamToken> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.mainModel,
        messages,
        stream: true,
      },
      { signal }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      const finishReason = chunk.choices[0]?.finish_reason;
      if (delta) {
        yield { text: delta, done: false };
      }
      if (finishReason) {
        yield { text: "", done: true };
      }
    }
  }

  async judgeContinuation(
    priorContext: ChatMessage[],
    newUtterance: string,
    signal: AbortSignal
  ): Promise<{ isContinuation: boolean; reasoning: string }> {
    const res = await this.client.chat.completions.create(
      {
        model: this.judgeModel,
        messages: [
          {
            role: "system",
            content:
              "あなたは音声アシスタントの発話判定器です。直前のやりとりの文脈を踏まえ、" +
              "新しく検出された発話が「アシスタントへの呼びかけの続き」か「無関係な発話（人間同士の会話など）」かを判定してください。" +
              "JSON形式で {\"is_continuation\": boolean, \"reasoning\": string} のみを返してください。",
          },
          ...priorContext,
          { role: "user", content: `新しい発話: ${newUtterance}` },
        ],
        response_format: { type: "json_object" },
      },
      { signal }
    );

    const content = res.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    return {
      isContinuation: Boolean(parsed.is_continuation),
      reasoning: String(parsed.reasoning ?? ""),
    };
  }
}
