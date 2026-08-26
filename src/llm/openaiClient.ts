import OpenAI from "openai";
import type { ChatMessage, LLMClient, StreamToken } from "./types.js";

export interface OpenAIClientOptions {
  apiKey: string;
  mainModel: string;
  judgeModel: string;
  /** OpenAI互換エンドポイント。将来のローカルQwen(vLLM)やテスト用の
   *  フェイクサーバに向ける場合に指定する。 */
  baseURL?: string;
  /** 判定呼び出しのタイムアウト。猶予ウィンドウを超えて待つ意味はないため短め。 */
  judgeTimeoutMs?: number;
}

/**
 * 本体モデル(streamChat)と判定用の軽量モデル(judgeContinuation)を使う実装。
 * baseURLを差し替えれば将来ローカルQwen3.6-35B-A3B等にも移行できる。
 */
export class OpenAILLMClient implements LLMClient {
  private client: OpenAI;
  private mainModel: string;
  private judgeModel: string;
  private judgeTimeoutMs: number;

  constructor(opts: OpenAIClientOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.mainModel = opts.mainModel;
    this.judgeModel = opts.judgeModel;
    this.judgeTimeoutMs = opts.judgeTimeoutMs ?? 3000;
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

    // グレースフル中断では for await を break で抜ける。その際 finally で
    // HTTPストリームを明示的に閉じないと、破棄したはずの残りトークンを
    // 受信し続けて課金・帯域が無駄になる。
    try {
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
    } finally {
      stream.controller.abort();
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
              'JSON形式で {"is_continuation": boolean, "reasoning": string} のみを返してください。',
          },
          ...priorContext,
          { role: "user", content: `新しい発話: ${newUtterance}` },
        ],
        response_format: { type: "json_object" },
      },
      { signal, timeout: this.judgeTimeoutMs }
    );

    const content = res.choices[0]?.message?.content ?? "{}";
    return parseJudgeResponse(content);
  }
}

/**
 * 判定モデルの応答をパースする。
 *
 * response_format=json_object を指定していても、モデルによっては
 * ```json フェンスで包む・前置きを付ける等の揺れがあるため、
 * 素の JSON.parse だけに頼ると実運用で例外になる。
 * パースに失敗した場合は「継続ではない」に倒す（誤って喋りかけている
 * 応答を中断してしまうより、追加発話を1回取りこぼす方が実害が小さい）。
 */
export function parseJudgeResponse(raw: string): {
  isContinuation: boolean;
  reasoning: string;
} {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  // 前置き付きでも最初の { ... } を拾えるようにする
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const candidate =
    start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return {
      isContinuation: Boolean(parsed.is_continuation),
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return {
      isContinuation: false,
      reasoning: `判定応答のパースに失敗したため継続なしとして扱った: ${raw.slice(0, 120)}`,
    };
  }
}
