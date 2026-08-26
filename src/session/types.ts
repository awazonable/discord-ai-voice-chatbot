export interface Utterance {
  text: string;
  speakerId: string;
  timestamp: number;
}

export type SessionState = "IDLE" | "AWAKENED" | "PROCESSING";

export interface SessionEvents {
  onPrimaryResponsePlay: (phrase: string) => void;
  /** 1文が完成し、音声合成キューに投入する準備ができたタイミング */
  onSentenceReady: (sentence: string) => void;
  onSpeechInterrupted: (reason: string) => void;
  onFinalResponse: (fullText: string) => void;
  onStateChange: (state: SessionState) => void;
  /** 追加発話の関連性判定が返ったタイミング（テスト・可観測性用） */
  onJudge?: (isContinuation: boolean, reasoning: string, utterance: string) => void;
  /**
   * LLM呼び出し失敗などの異常系。
   * ラウンドはバックグラウンドで走るため、これが無いと実API利用時に
   * モデル名誤りや認証エラーが unhandled rejection として消える。
   */
  onError?: (err: unknown, context: string) => void;
}
