/**
 * VOICEVOXがまだ繋がっていないため、文字数から再生時間を概算する仮実装。
 * 実際の合成+再生時間が取れるようになったら enqueue の見積り部分を差し替える。
 *
 * テキストストリームはトークン生成の速さで進むが、音声再生はそれよりずっと
 * 遅い（この概算では10文字/秒）。onSentenceReady で流れてくる文をここに
 * 順番に積むことで、「テキスト上は生成が終わっている/中断できている」のに
 * 「実際にはまだ何秒分もの音声が再生待ちで残っている」というズレを追跡する。
 */
const SEC_PER_CHAR = 0.1;

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
