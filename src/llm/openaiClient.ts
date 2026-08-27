import OpenAI from "openai";
import type { ChatMessage, LLMClient, StreamToken, ToolConfig } from "./types.js";
import { logLLMCall } from "./callLogger.js";

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_TOOL_ITERATIONS = 6;

export interface OpenAIClientOptions {
  apiKey: string;
  mainModel: string;
  judgeModel: string;
  /** OpenAI互換エンドポイント。将来のローカルQwen(vLLM)やテスト用の
   *  フェイクサーバに向ける場合に指定する。 */
  baseURL?: string;
  /** 判定呼び出しのタイムアウト。猶予ウィンドウを超えて待つ意味はないため短め。 */
  judgeTimeoutMs?: number;
  /** 要約呼び出しのタイムアウト。会話ログの圧縮には判定より長い猶予を与える。 */
  summaryTimeoutMs?: number;
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
  private summaryTimeoutMs: number;

  constructor(opts: OpenAIClientOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.mainModel = opts.mainModel;
    this.judgeModel = opts.judgeModel;
    this.judgeTimeoutMs = opts.judgeTimeoutMs ?? 3000;
    this.summaryTimeoutMs = opts.summaryTimeoutMs ?? 10000;
  }

  async *streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    tools?: ToolConfig
  ): AsyncGenerator<StreamToken> {
    const oaiTools = tools?.definitions.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    let workingMessages: OAIMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    }));

    // ツール呼び出しが続く限りループする（検索してから保存、等の多段呼び出しに対応）。
    // 無限ループ防止に上限を設ける。
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const startedAt = Date.now();
      let iterText = "";
      let finishReason: string | null = null;
      let errorMsg: string | undefined;
      const toolCallBuilders = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      const stream = await this.client.chat.completions.create(
        {
          model: this.mainModel,
          messages: workingMessages,
          stream: true,
          // gpt-5.6系はreasoningモデルで、reasoning_effortが立っていると
          // /v1/chat/completions 経由のfunction toolsを拒否する(400)。
          // ツールを渡す場合は無効化する(src/toolCallTest.tsで確認済み)。
          ...(oaiTools ? { tools: oaiTools, reasoning_effort: "none" } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal }
      );

      // グレースフル中断では for await を break で抜ける。その際 finally で
      // HTTPストリームを明示的に閉じないと、破棄したはずの残りトークンを
      // 受信し続けて課金・帯域が無駄になる。
      // なお、消費側が break すると非同期ジェネレータの finally も実行される
      // （暗黙に .return() が呼ばれる仕様）ため、グレースフル中断で打ち切った
      // 場合も「そこまでに生成されたテキスト」がログに残る。
      try {
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const delta = choice?.delta;

          if (delta?.content) {
            iterText += delta.content;
            yield { text: delta.content, done: false };
          }

          for (const tc of delta?.tool_calls ?? []) {
            const existing = toolCallBuilders.get(tc.index) ?? {
              id: "",
              name: "",
              args: "",
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
            toolCallBuilders.set(tc.index, existing);
          }

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        stream.controller.abort();
        logLLMCall({
          timestamp: new Date(startedAt).toISOString(),
          kind: "main",
          model: this.mainModel,
          messages: workingMessages as unknown as ChatMessage[],
          responseText:
            iterText ||
            (toolCallBuilders.size > 0
              ? `[tool_calls: ${[...toolCallBuilders.values()].map((t) => t.name).join(", ")}]`
              : ""),
          latencyMs: Date.now() - startedAt,
          error: errorMsg,
        });
      }

      const hasToolCalls = toolCallBuilders.size > 0;
      if (!tools || finishReason !== "tool_calls" || !hasToolCalls) {
        yield { text: "", done: true };
        return;
      }

      const toolCalls = [...toolCallBuilders.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => tc);

      workingMessages = [
        ...workingMessages,
        {
          role: "assistant",
          content: iterText || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          })),
        },
      ];

      for (const tc of toolCalls) {
        let result: string;
        try {
          result = await tools.onCall(tc.name, tc.args);
        } catch (err) {
          result = `エラー: ${err instanceof Error ? err.message : String(err)}`;
        }
        workingMessages = [
          ...workingMessages,
          { role: "tool", tool_call_id: tc.id, content: result },
        ];
      }
    }

    // 上限に達した場合も呼び出し元をハングさせない
    yield { text: "", done: true };
  }

  async judgeContinuation(
    priorContext: ChatMessage[],
    newUtterance: string,
    signal: AbortSignal
  ): Promise<{
    isContinuation: boolean;
    abandonsCurrent: boolean;
    reasoning: string;
  }> {
    const startedAt = Date.now();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "あなたは音声アシスタントの発話判定器です。" +
          "ユーザーは現在3人で会話しています。あなた（ずんだもん）はその場にいる話者の一人に過ぎず、" +
          "検出される発話のすべてがあなた宛とは限りません。他の参加者への質問や、参加者同士の雑談も混ざります。" +
          "直前のやりとりの文脈を踏まえ、新しく検出された発話について次の2点を判定してください。\n" +
          "(1) is_continuation: 「あなたへの呼びかけの続き」か「あなた宛ではない発話" +
          "（他の参加者への質問・参加者同士の会話など）」か。疑問形かどうかだけで判定しないこと。" +
          "疑問文であっても、話題が直前のやりとりと無関係、または他の参加者に向けられていると" +
          "読めるなら、あなた宛ではないと判定してください。\n" +
          "(2) abandons_current: is_continuationがtrueの場合のみ意味を持つ。" +
          "「やっぱりいいや」「それより」のように、今あなたが話している内容を打ち切って" +
          "別の話に切り替えたい意図ならtrue。「ついでに」「あと」「それと」のように、" +
          "今話している内容はそのまま聞いた上で追加で聞きたいだけならfalse。" +
          "判断がつかない場合もfalseにしてください。\n" +
          'JSON形式で {"is_continuation": boolean, "abandons_current": boolean, "reasoning": string} ' +
          "のみを返してください。",
      },
      ...priorContext,
      { role: "user", content: `新しい発話: ${newUtterance}` },
    ];

    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.judgeModel,
          messages,
          response_format: { type: "json_object" },
        },
        { signal, timeout: this.judgeTimeoutMs }
      );

      const content = res.choices[0]?.message?.content ?? "{}";
      const parsed = parseJudgeResponse(content);
      logLLMCall({
        timestamp: new Date(startedAt).toISOString(),
        kind: "judge",
        model: this.judgeModel,
        messages,
        responseText: content,
        parsed,
        latencyMs: Date.now() - startedAt,
      });
      return parsed;
    } catch (err) {
      logLLMCall({
        timestamp: new Date(startedAt).toISOString(),
        kind: "judge",
        model: this.judgeModel,
        messages,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async summarize(
    messages: ChatMessage[],
    priorSummary: string,
    signal: AbortSignal
  ): Promise<{ summary: string; facts: string[] }> {
    const startedAt = Date.now();
    const transcript = messages
      .map((m) => `${m.role === "user" ? "ユーザー" : "ずんだもん"}: ${m.content}`)
      .join("\n");

    const requestMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "あなたは音声アシスタントの短期記憶を圧縮する要約器です。" +
          "以下の「これまでの要約」と「新しい会話ログ」を統合し、今後の会話で" +
          "参照する価値がある情報だけを残した新しい要約を作ってください。" +
          "世間話や既に用済みのやりとりは削ってよい。" +
          'JSON形式で {"summary": string, "facts": string[]} のみを返してください。' +
          "summaryは2〜3文程度、factsはユーザーについて分かった具体的な事実のみ" +
          "（無ければ空配列）。",
      },
      {
        role: "user",
        content:
          `これまでの要約: ${priorSummary || "(なし)"}\n\n新しい会話ログ:\n${transcript}`,
      },
    ];

    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.judgeModel,
          messages: requestMessages,
          response_format: { type: "json_object" },
        },
        { signal, timeout: this.summaryTimeoutMs }
      );

      const content = res.choices[0]?.message?.content ?? "{}";
      const parsed = parseSummaryResponse(content, priorSummary);
      logLLMCall({
        timestamp: new Date(startedAt).toISOString(),
        kind: "judge",
        model: this.judgeModel,
        messages: requestMessages,
        responseText: content,
        parsed,
        latencyMs: Date.now() - startedAt,
      });
      return parsed;
    } catch (err) {
      logLLMCall({
        timestamp: new Date(startedAt).toISOString(),
        kind: "judge",
        model: this.judgeModel,
        messages: requestMessages,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

function parseSummaryResponse(
  raw: string,
  fallbackSummary: string
): { summary: string; facts: string[] } {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const candidate = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.filter((f): f is string => typeof f === "string")
      : [];
    return { summary: String(parsed.summary ?? fallbackSummary), facts };
  } catch {
    // パースに失敗しても要約全体を捨てず、元の要約を維持する
    return { summary: fallbackSummary, facts: [] };
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
  abandonsCurrent: boolean;
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
      abandonsCurrent: Boolean(parsed.abandons_current),
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return {
      isContinuation: false,
      abandonsCurrent: false,
      reasoning: `判定応答のパースに失敗したため継続なしとして扱った: ${raw.slice(0, 120)}`,
    };
  }
}
