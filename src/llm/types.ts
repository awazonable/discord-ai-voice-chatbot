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
   *
   * isContinuation と abandonsCurrent は独立した軸:
   *  - isContinuation: あなた宛の発話か（無関係なら丸ごと無視）
   *  - abandonsCurrent: あなた宛だとして、今の応答を打ち切りたい意図か
   *    （「やっぱりいいや」等）／それとも追加で聞きたいだけで今の応答は
   *    そのまま聞きたいのか（「ついでに」等）。isContinuation=falseの
   *    ときは意味を持たない。
   */
  judgeContinuation(
    priorContext: ChatMessage[],
    newUtterance: string,
    signal: AbortSignal
  ): Promise<{
    isContinuation: boolean;
    abandonsCurrent: boolean;
    reasoning: string;
  }>;
}
