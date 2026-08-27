export interface SynthesizeOptions {
  /** 話者ID（VOICEVOXのスタイルID）。未指定ならクライアント側の既定値を使う。 */
  speaker?: number;
  pitch?: number;
  intonationScale?: number;
  speed?: number;
}

export interface SynthesizeResult {
  audio: Buffer;
  /** レスポンスヘッダから取得した実際のMIMEタイプ（例: audio/wav）。 */
  contentType: string;
}

export interface SpeakerStyle {
  name: string;
  id: number;
}

export interface Speaker {
  name: string;
  styles: SpeakerStyle[];
}

/**
 * LLMClient（src/llm/types.ts）と同じ発想で、音声合成の実装を差し替え可能に
 * しておく抽象インターフェース。今はsu-shiki(Web版VOICEVOX API)実装のみ。
 * 将来ローカルVOICEVOXエンジンに乗り換える際もこのインターフェースは
 * そのまま使える想定。
 */
export interface TTSClient {
  synthesize(text: string, opts?: SynthesizeOptions): Promise<SynthesizeResult>;
  listSpeakers(): Promise<Speaker[]>;
}
