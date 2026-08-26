import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { findZundamonSpeakerId } from "./tts/sushikiClient.js";
import { createTTSClient, describeTTSConfig } from "./tts/createTTSClient.js";
import { playWavFile, PersistentPowerShellPlayer } from "./tts/playback.js";
import { getWavDurationMs } from "./tts/wav.js";

/**
 * 「見積り(0.1秒/文字) vs 実測」の差が、音声そのものの長さの見積りが
 * 甘いのか、それともPowerShellプロセスの起動オーバーヘッドなのかを
 * 確定させる。
 *
 * TTS合成は1回だけ行い（コスト削減のため）、同じWAVを
 *   (A) playWavFile()            = 再生のたびに新規プロセスを起動
 *   (B) PersistentPowerShellPlayer = プロセスを使い回す
 * の両方で再生して壁時計を計測し、WAVヘッダの実長と比較する。
 */

const TEST_SENTENCES = [
  "こんにちはなのだ",
  "今日はいい天気なのだ",
  "遠足の持ち物を確認するのだ、忘れ物がないか気をつけるのだ",
];

async function main() {
  const cfg = loadConfig();

  console.log("=== 再生オーバーヘッド切り分けテスト ===");
  console.log(describeTTSConfig(cfg));
  console.log();

  const tts = createTTSClient(cfg);
  const speakers = await tts.listSpeakers();
  const speakerId = findZundamonSpeakerId(speakers) ?? 3;

  mkdirSync("output", { recursive: true });

  interface Row {
    text: string;
    wavMs: number;
    spawnMs: number;
    persistentMs: number;
  }
  const rows: Row[] = [];

  console.log("[1] 合成中（1回だけ）...");
  const files: string[] = [];
  for (let i = 0; i < TEST_SENTENCES.length; i++) {
    const text = TEST_SENTENCES[i]!;
    const { audio } = await tts.synthesize(text, { speaker: speakerId });
    const path = `output/overhead-${i}.wav`;
    writeFileSync(path, audio);
    files.push(path);
    const wavMs = getWavDurationMs(audio);
    console.log(`  "${text}" (${text.length}文字) -> ${path} (WAV実長=${wavMs?.toFixed(0)}ms)`);
    rows.push({ text, wavMs: wavMs ?? -1, spawnMs: -1, persistentMs: -1 });
  }

  console.log("\n[2] 方式A: 再生のたびに新規プロセスを起動 (playWavFile)");
  for (let i = 0; i < files.length; i++) {
    const { durationMs } = await playWavFile(files[i]!);
    rows[i]!.spawnMs = durationMs;
    console.log(`  ${files[i]} -> 実測=${durationMs}ms`);
  }

  console.log("\n[3] 方式B: プロセスを1つ使い回す (PersistentPowerShellPlayer)");
  const player = new PersistentPowerShellPlayer();
  player.start();
  // シェルの起動自体にかかる時間はウォームアップとして計測対象から外す
  await new Promise((r) => setTimeout(r, 500));
  for (let i = 0; i < files.length; i++) {
    const { durationMs } = await player.play(files[i]!);
    rows[i]!.persistentMs = durationMs;
    console.log(`  ${files[i]} -> 実測=${durationMs}ms`);
  }
  player.stop();

  console.log("\n=== 結果まとめ ===");
  console.log(
    "  文字数 | WAV実長  | 方式A(実測/差分)      | 方式B(実測/差分)"
  );
  let sumSpawnOverhead = 0;
  let sumPersistentOverhead = 0;
  for (const r of rows) {
    const spawnDiff = r.spawnMs - r.wavMs;
    const persistentDiff = r.persistentMs - r.wavMs;
    sumSpawnOverhead += spawnDiff;
    sumPersistentOverhead += persistentDiff;
    console.log(
      `  ${String(r.text.length).padStart(4)}文字 | ${r.wavMs.toFixed(0).padStart(6)}ms | ` +
        `${r.spawnMs.toFixed(0).padStart(6)}ms (+${spawnDiff.toFixed(0)}ms) | ` +
        `${r.persistentMs.toFixed(0).padStart(6)}ms (+${persistentDiff.toFixed(0)}ms)`
    );
  }
  const avgSpawnOverhead = sumSpawnOverhead / rows.length;
  const avgPersistentOverhead = sumPersistentOverhead / rows.length;
  console.log(
    `\n  平均オーバーヘッド: 方式A(毎回起動)=${avgSpawnOverhead.toFixed(0)}ms / ` +
      `方式B(使い回し)=${avgPersistentOverhead.toFixed(0)}ms`
  );
  console.log(
    avgPersistentOverhead < avgSpawnOverhead * 0.5
      ? "  -> 方式Bでオーバーヘッドが大きく縮んだ。プロセス起動コストが犯人と確定。"
      : "  -> 方式Bでも大差が無い。プロセス起動コスト以外の要因も疑うべき。"
  );
}

main().catch((err) => {
  console.error("✗ テストに失敗しました:", err);
  process.exit(1);
});
