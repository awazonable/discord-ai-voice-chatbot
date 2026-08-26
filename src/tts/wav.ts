/**
 * WAVヘッダから音声そのものの長さ(ms)を読み取る。
 *
 * 「見積り(0.1秒/文字) vs 実測(壁時計)」の差が、音声そのものの長さの
 * 見積りが甘いのか、それとも再生プロセスの起動オーバーヘッドなのかを
 * 切り分けるための客観的な基準値として使う。data チャンクの直前に
 * 他のチャンク(LIST等)が挟まる場合もあるため、固定オフセットではなく
 * "data" マーカーを探して読む。
 */
export function getWavDurationMs(buf: Buffer): number | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let sampleRate: number | null = null;
  let byteRate: number | null = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === "fmt " && bodyStart + 16 <= buf.length) {
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      byteRate = buf.readUInt32LE(bodyStart + 8);
    }

    if (chunkId === "data") {
      if (byteRate && byteRate > 0) {
        return (chunkSize / byteRate) * 1000;
      }
      // fmtが先に見つかっていない異常なファイル構成
      return null;
    }

    offset = bodyStart + chunkSize + (chunkSize % 2); // 奇数長は1バイトパディングされる
  }

  return null;
}
