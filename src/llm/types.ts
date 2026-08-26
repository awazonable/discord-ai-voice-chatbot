export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamToken {
  text: string;
  done: boolean;
}

/**
 * LLM呼び出しの抽象インターフェース。
 * ストリーミングでトークンを返し、AbortSignalで中断できる。
 * 実装は OpenAI 版とモック版を差し替え可能にする。
 */
export interface LLMClient {
  streamChat(
    messages: ChatMessage[],
    signal: AbortSignal
  ): AsyncGenerator<StreamToken>;

  /**
   * 追加発話が「呼びかけの続き」か「無関係な発話」かを判定する軽量呼び出し。
   * 本体LLMとは別に、安価・低レイテンシなモデルを想定。
   */
  judgeContinuation(
    priorContext: ChatMessage[],
    newUtterance: string,
    signal: AbortSignal
  ): Promise<{ isContinuation: boolean; reasoning: string }>;
}
