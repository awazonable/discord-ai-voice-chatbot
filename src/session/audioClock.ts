/**
 * VOICEVOX(su-shiki)を実際に再生キューへつなぎ込むまでの、文字数から
 * 再生時間を概算する仮実装。
 *
 * テキストストリームはトークン生成の速さで進むが、音声再生はそれよりずっと
 * 遅い。onSentenceReady で流れてくる文をここに順番に積むことで、
 * 「テキスト上は生成が終わっている/中断できている」のに「実際にはまだ
 * 何秒分もの音声が再生待ちで残っている」というズレを追跡する。
 *
 * 値は src/ttsOverheadTest.ts で実測したWAVヘッダ上の実長から算出
 * （8/10/28文字でそれぞれ約161/161/171ms/文字、平均約0.165秒/文字）。
 * サンプル数が少ないため今後の実測で更新してよい。
 */
export const SEC_PER_CHAR = 0.165;

interface QueuedSentence {
  text: string;
  startMs: number;
  endMs: number;
}

export class AudioClock {
  private queue: QueuedSentence[] = [];
  private queueEndMs = 0;

  constructor(private now: () => number = Date.now) {}

  /** 文をキューの末尾に積む（前の文の再生が終わってから始まる想定） */
  enqueue(text: string): QueuedSentence {
    const start = Math.max(this.queueEndMs, this.now());
    const durationMs = text.length * SEC_PER_CHAR * 1000;
    const entry: QueuedSentence = { text, startMs: start, endMs: start + durationMs };
    this.queue.push(entry);
    this.queueEndMs = entry.endMs;
    return entry;
  }

  /** 現在時刻において、まだ再生し終わっていない音声がキューにあるか */
  isPlaying(at = this.now()): boolean {
    return this.queueEndMs > at;
  }

  /** 現在時刻までにキューが再生し終える残り時間(ms) */
  remainingMs(at = this.now()): number {
    return Math.max(0, this.queueEndMs - at);
  }

  /**
   * 中断: まだ再生が始まっていない（＝テキスト上は既に生成済みだが
   * 耳にはまだ届いていない）文をキューから捨てる。
   * 再生中・再生済みの文はそのまま流し切らせる。
   */
  truncateToCurrent(at = this.now()): {
    discarded: number;
    discardedChars: number;
    savedMs: number;
  } {
    const keep = this.queue.filter((e) => e.startMs <= at);
    const dropped = this.queue.filter((e) => e.startMs > at);

    this.queue = keep;
    this.queueEndMs = keep.length > 0 ? Math.max(...keep.map((e) => e.endMs)) : at;

    return {
      discarded: dropped.length,
      discardedChars: dropped.reduce((sum, e) => sum + e.text.length, 0),
      savedMs: dropped.reduce((sum, e) => sum + (e.endMs - e.startMs), 0),
    };
  }
}
