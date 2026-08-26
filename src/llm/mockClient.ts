import type { ChatMessage, LLMClient, StreamToken } from "./types.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

/**
 * 実APIを使わずロジック検証するためのモック。
 * - streamChat: 最後のuserメッセージ内容に応じて適当な応答をトークンごとに返す
 *   (150msごとに1トークン、というのを疑似的なストリーミング速度として模擬)
 * - judgeContinuation: 簡易ヒューリスティックで判定（本来はLLM呼び出し）
 */
export class MockLLMClient implements LLMClient {
  constructor(private tokenDelayMs = 150) {}

  async *streamChat(
    messages: ChatMessage[],
    signal: AbortSignal
  ): AsyncGenerator<StreamToken> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const query = lastUser?.content ?? "";

    let responseText: string;
    if (query.includes("天気")) {
      responseText = "天気が分かったのだ。明日は晴れなのだ。傘はいらないのだ。";
    } else if (query.includes("遠足")) {
      responseText =
        "明日は遠足なのだ。楽しみなのだ。持ち物の準備はできているのだ。天気も良さそうなのだ。";
    } else {
      responseText = "調べているのだ。";
    }

    const tokens = responseText.match(/.{1,3}/g) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      await sleep(this.tokenDelayMs, signal);
      yield { text: tokens[i], done: i === tokens.length - 1 };
    }
  }

  async judgeContinuation(
    _priorContext: ChatMessage[],
    newUtterance: string,
    signal: AbortSignal
  ): Promise<{ isContinuation: boolean; reasoning: string }> {
    await sleep(80, signal);
    // ヒューリスティック: 「ずんだもん」等の呼びかけ語や疑問形を含めば継続とみなす
    const continuationHints = ["？", "?", "教えて", "調べて", "やって", "わかる"];
    const isContinuation = continuationHints.some((h) => newUtterance.includes(h));
    return {
      isContinuation,
      reasoning: isContinuation
        ? "疑問・依頼の形を含むため継続と判定"
        : "呼びかけへの応答ではなく別の発話と判定",
    };
  }
}
