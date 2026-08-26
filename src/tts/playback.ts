import { spawn } from "node:child_process";

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
