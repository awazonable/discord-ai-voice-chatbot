export interface Utterance {
  text: string;
  speakerId: string;
  /** 表示用の話者名（Discordのユーザー名等）。無ければspeakerIdを使う。 */
  speakerName?: string;
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
  /**
   * グレースフル中断時、まだ再生が始まっていなかった（＝テキストは生成済み
   * だが耳にはまだ届いていなかった）文を音声キューから破棄したタイミング。
   * テキスト生成時間と実際の再生時間のズレを可視化するための計測用。
   */
  onAudioTruncated?: (discardedSentences: number, discardedChars: number, savedMs: number) => void;
  /** 会話ログの古い部分が短期記憶(要約+重要な事実)に圧縮されたタイミング。テスト・可観測性用。 */
  onMemoryCompacted?: (summary: string, facts: string[]) => void;
  /** 追加発話の関連性判定が返ったタイミング（テスト・可観測性用） */
  onJudge?: (isContinuation: boolean, reasoning: string, utterance: string) => void;
  /**
   * LLM呼び出し失敗などの異常系。
   * ラウンドはバックグラウンドで走るため、これが無いと実API利用時に
   * モデル名誤りや認証エラーが unhandled rejection として消える。
   */
  onError?: (err: unknown, context: string) => void;
}
