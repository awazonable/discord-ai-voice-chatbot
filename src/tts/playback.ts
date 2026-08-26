import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * WAVファイルをホストのスピーカーで再生し、実際にかかった時間を計測する。
 * Windows専用（PowerShellの System.Media.SoundPlayer を使う。WAV専用API
 * のため、mp3/ogg等が返ってきた場合はこの関数では再生できない）。
 *
 * Discord/実機接続前の「本当に音が鳴るか・どれくらい時間がかかるか」を
 * 確認するための仮実装。
 */
export function playWavFile(path: string): Promise<{ durationMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const escaped = path.replace(/'/g, "''");
    const psCommand = `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`;

    const proc = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psCommand,
    ]);

    let stderr = "";
    proc.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      const durationMs = Date.now() - started;
      if (code !== 0) {
        reject(new Error(`再生プロセスが異常終了しました (code=${code}): ${stderr}`));
        return;
      }
      resolve({ durationMs });
    });
  });
}

interface PendingPlay {
  token: string;
  resolve: (durationMs: number) => void;
  reject: (err: Error) => void;
  startedAt: number;
}

/**
 * playWavFile() は再生1回ごとにPowerShellプロセスを新規起動するため、
 * 実測でこのプロセス起動コストが再生時間に埋もれて乗ってくることが
 * わかった（audioClockの見積りとの差が文字数に比例せず、ほぼ一定
 * だったことから）。これを検証・解消するため、PowerShellプロセスを
 * 1つ起動したまま使い回し、標準入力経由でコマンドを流し込む版。
 * 同じWAVを再生させて playWavFile() と実測を比較すれば、差が
 * プロセス起動コストだったかどうかを直接確認できる。
 */
export class PersistentPowerShellPlayer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private outBuffer = "";
  private pending: PendingPlay[] = [];

  start(): void {
    if (this.proc) return;
    this.proc = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "-",
    ]);
    this.proc.stdout.on("data", (chunk) => {
      this.outBuffer += String(chunk);
      this.drain();
    });
    this.proc.on("exit", () => {
      for (const p of this.pending) {
        p.reject(new Error("PowerShellプロセスが終了しました"));
      }
      this.pending = [];
      this.proc = null;
    });
  }

  private drain() {
    let idx: number;
    while ((idx = this.outBuffer.indexOf("\n")) !== -1) {
      const line = this.outBuffer.slice(0, idx).trim();
      this.outBuffer = this.outBuffer.slice(idx + 1);
      const m = /^DONE:(\S+)$/.exec(line);
      if (!m) continue;
      const i = this.pending.findIndex((p) => p.token === m[1]);
      if (i === -1) continue;
      const [p] = this.pending.splice(i, 1);
      p!.resolve(Date.now() - p!.startedAt);
    }
  }

  play(path: string): Promise<{ durationMs: number }> {
    if (!this.proc) throw new Error("PersistentPowerShellPlayer が起動していません");
    const token = randomUUID();
    const escaped = path.replace(/'/g, "''");
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      this.pending.push({
        token,
        resolve: (durationMs) => resolve({ durationMs }),
        reject,
        startedAt,
      });
      this.proc!.stdin.write(
        `(New-Object Media.SoundPlayer '${escaped}').PlaySync(); Write-Output 'DONE:${token}'\r\n`
      );
    });
  }

  stop(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
  }
}
