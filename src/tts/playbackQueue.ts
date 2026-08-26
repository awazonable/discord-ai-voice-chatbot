import { mkdirSync, writeFileSync } from "node:fs";
import type { TTSClient } from "./types.js";
import { playWavFile } from "./playback.js";

export interface PlaybackQueueOptions {
  tts: TTSClient;
  speaker?: number;
  onSentenceStart?: (text: string) => void;
  onSentenceDone?: (text: string, measuredMs: number) => void;
  onError?: (err: unknown, text: string) => void;
}

/**
 * onSentenceReady から渡された文を順番に「合成→スピーカー再生」する
 * 実物のキュー。VOICEVOX接続の骨組み確認用（本番でDiscordへ送出する
 * 部分は未実装）。
 *
 * ZundamonSession の AudioClock はテキスト生成時間の中で「未再生の文を
 * 破棄する」シミュレーションでしかない。実際に鳴っている音を止めるには
 * このキュー側でも同じタイミングで truncatePending() を呼ぶ必要がある
 * （呼び出し側は SessionEvents.onAudioTruncated を使って両方に伝える）。
 */
export class RealPlaybackQueue {
  private pending: string[] = [];
  private processing = false;
  private counter = 0;

  constructor(private opts: PlaybackQueueOptions) {}

  enqueue(text: string) {
    this.pending.push(text);
    void this.drain();
  }

  /** グレースフル中断時: まだ再生を開始していない分をキューから捨てる */
  truncatePending(): number {
    const n = this.pending.length;
    this.pending = [];
    return n;
  }

  /** 未処理のテキストが残っている、または合成/再生の真っ最中か */
  isBusy(): boolean {
    return this.processing || this.pending.length > 0;
  }

  private async drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pending.length > 0) {
        const text = this.pending.shift();
        if (text === undefined) break;

        this.opts.onSentenceStart?.(text);
        try {
          const { audio } = await this.opts.tts.synthesize(text, {
            speaker: this.opts.speaker,
          });
          mkdirSync("output", { recursive: true });
          const path = `output/playback-${++this.counter}.wav`;
          writeFileSync(path, audio);

          const { durationMs } = await playWavFile(path);
          this.opts.onSentenceDone?.(text, durationMs);
        } catch (err) {
          this.opts.onError?.(err, text);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
