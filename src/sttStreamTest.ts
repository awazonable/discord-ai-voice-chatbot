// @ts-nocheck
import sherpa_onnx from "sherpa-onnx-node";
import { loadConfig } from "./config.js";
import { SttEngine } from "./stt/sttEngine.js";
import { createTTSClient } from "./tts/createTTSClient.js";
import { findZundamonSpeakerId } from "./tts/sushikiClient.js";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * VAD+STTエンジンの疎通テスト。実際のマイクは無いので、VOICEVOXで
 * 「ずんだもん、こんにちは」を合成し、それを小さいチャンク(100ms)に
 * 分割して少しずつ流し込むことで、Discord等からの逐次到着音声を模擬する。
 * 前後に無音を足し、VADが正しく発話区間の始まり・終わりを検出できるかも見る。
 */

const CHUNK_MS = 100;

async function main() {
  const cfg = loadConfig();
  const modelDir = `${cfg.modelsDir}/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01`;
  const vadModelPath = `${cfg.modelsDir}/silero_vad_v5.onnx`;

  console.log("=== VAD+STT ストリーミング疎通テスト ===\n");

  console.log("[1] テスト用音声をVOICEVOXで合成中...");
  const tts = createTTSClient(cfg);
  const speakers = await tts.listSpeakers();
  const speakerId = findZundamonSpeakerId(speakers) ?? 3;
  const { audio } = await tts.synthesize("ずんだもん、こんにちは", { speaker: speakerId });
  mkdirSync("output", { recursive: true });
  writeFileSync("output/stt-stream-test.wav", audio);
  console.log(`  ✓ 合成完了 (${audio.length} bytes)\n`);

  console.log("[2] 音声を読み込み、前後に無音を足してチャンク分割...");
  const wave = sherpa_onnx.readWave("output/stt-stream-test.wav");
  const sr = wave.sampleRate;
  const silence = new Float32Array(sr * 0.5); // 前後0.5秒の無音
  const full = new Float32Array(silence.length * 2 + wave.samples.length);
  full.set(silence, 0);
  full.set(wave.samples, silence.length);
  full.set(silence, silence.length + wave.samples.length);

  const chunkSize = Math.floor((sr * CHUNK_MS) / 1000);
  console.log(
    `  合計 ${(full.length / sr).toFixed(2)}秒 を ${CHUNK_MS}ms チャンク(${chunkSize}サンプル)で流す\n`
  );

  console.log("[3] STTエンジン初期化中...");
  const engine = new SttEngine({ modelDir, vadModelPath });
  console.log("  ✓ 初期化完了\n");

  console.log("[4] チャンクを逐次投入...");
  const allResults: { text: string; durationMs: number; decodeMs: number }[] = [];
  let segIndex = 0;
  for (let offset = 0; offset < full.length; offset += chunkSize) {
    const chunk = full.subarray(offset, Math.min(offset + chunkSize, full.length));
    const results = engine.pushSamples(chunk, sr, (segAudio: Float32Array) => {
      sherpa_onnx.writeWave(`output/stt-seg-${segIndex}.wav`, {
        samples: segAudio,
        sampleRate: 16000,
      });
      segIndex++;
    });
    for (const r of results) {
      console.log(
        `  >>> 発話確定: "${r.text}" (音声長=${r.durationMs.toFixed(0)}ms, ` +
          `認識時間=${r.decodeMs}ms)`
      );
      allResults.push(r);
    }
  }
  const flushed = engine.flush();
  for (const r of flushed) {
    console.log(`  >>> 発話確定(flush): "${r.text}"`);
    allResults.push(r);
  }

  console.log(`\n=== 結果: ${allResults.length}件の発話区間を検出 ===`);
  const ok = allResults.some((r) => r.text.includes("ずんだもん") && r.text.includes("こんにちは"));
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ テストに失敗しました:", err);
  process.exit(1);
});
