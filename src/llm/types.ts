export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * 発話者を区別するための識別子（OpenAI APIのmessage.nameに対応）。
   * 複数話者が同じ会話に参加する場合、role="user"だけでは誰の発言か
   * LLMから見て区別が付かない。英数字・アンダースコア・ハイフンのみ
   * （OpenAI APIの制約）。
   */
  name?: string;
}

export interface StreamToken {
  text: string;
  done: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (type: "object", properties, required 等)。 */
  parameters: Record<string, unknown>;
}

/** ツール呼び出しを実行し、結果を文字列で返す。例外を投げると呼び出し元でエラー扱いになる。 */
export type ToolCallHandler = (name: string, argsJson: string) => Promise<string>;

export interface ToolConfig {
  definitions: ToolDefinition[];
  onCall: ToolCallHandler;
}

/**
 * LLM呼び出しの抽象インターフェース。
 * ストリーミングでトークンを返し、AbortSignalで中断できる。
 * 実装は OpenAI 版とモック版を差し替え可能にする。
 */
export interface LLMClient {
  /**
   * tools を渡すと、モデルがツール呼び出しを選んだ場合は
   * ToolConfig.onCall で実行し、結果を会話に積んでから続きを
   * ストリーミングする（複数回のツール呼び出しにも対応）。
   * 呼び出し元にはツール呼び出し自体は見せず、最終的なテキスト
   * トークンだけを流す。
   */
  streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    tools?: ToolConfig
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

  /**
   * 会話ログの古い部分を短期記憶（要約+重要な事実）に圧縮する軽量呼び出し。
   * judgeContinuationと同じく安価・低レイテンシなモデルを想定。
   */
  summarize(
    messages: ChatMessage[],
    priorSummary: string,
    signal: AbortSignal
  ): Promise<{ summary: string; facts: string[] }>;
}
