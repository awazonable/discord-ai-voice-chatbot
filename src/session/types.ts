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
}
