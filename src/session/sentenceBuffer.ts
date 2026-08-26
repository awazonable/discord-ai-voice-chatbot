/**
 * ストリーミングトークンを受け取り、句点等で文単位に区切って発行するバッファ。
 * 「言い終わらせてから中断」を実現するため、中断要求が来ても
 * 現在組み立て中の文が完成するまでは通常通り発行し、
 * その文の完成を区切りに残りを破棄する。
 */
const SENTENCE_BOUNDARY = /(?<=[。！？!?])/;

export class SentenceStreamBuffer {
  private buffer = "";
  private interruptRequested = false;

  /** トークンを追加し、完成した文があれば配列で返す */
  push(token: string): string[] {
    this.buffer += token;
    const parts = this.buffer.split(SENTENCE_BOUNDARY);

    // 最後の要素は未完成の可能性があるので保持
    const completed = parts.slice(0, -1);
    this.buffer = parts[parts.length - 1] ?? "";

    return completed.filter((s) => s.length > 0);
  }

  /** 中断要求: 現在組み立て中の文が完成したら止める、という意思表示 */
  requestInterrupt() {
    this.interruptRequested = true;
  }

  isInterruptRequested() {
    return this.interruptRequested;
  }

  /** ストリーム終了時、buffer に残っている未完成テキストを文として確定させる */
  flush(): string[] {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining.length > 0 ? [remaining] : [];
  }
}
