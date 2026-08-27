// @ts-nocheck  sherpa-onnx-node は型定義を配布していないため素通しで扱う
import sherpa_onnx from "sherpa-onnx-node";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";

/**
 * ReazonSpeech Zipformer (sherpa-onnx, オフライン認識) の単発疎通テスト。
 * モデル同梱のtest_wavs（正解のtranscript.txt付き）を使い、
 * 実際に認識できているかを比較する。
 *
 * 注記: ダウンロードした
 * sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01 は、ディレクトリ名に
 * "streaming" が付いていない = オフライン(発話全体を一括デコード)用の
 * エクスポート。stt-design.md が想定していた「partial: 0.5秒間隔で更新」
 * のようなストリーミング部分更新はこのモデルでは行えない。
 * VAD区間検出→区間ごとにオフライン認識、という構成になる
 * （final確定は無音検出のタイミングで行う形はstt-design.mdの方針と両立する）。
 */

async function main() {
  const cfg = loadConfig();
  const modelDir = `${cfg.modelsDir}/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01`;

  console.log("=== STT(ReazonSpeech Zipformer, オフライン認識) 疎通テスト ===");
  console.log(`  model dir: ${modelDir}\n`);

  const recognizer = new sherpa_onnx.OfflineRecognizer({
    modelConfig: {
      transducer: {
        encoder: `${modelDir}/encoder-epoch-99-avg-1.int8.onnx`,
        decoder: `${modelDir}/decoder-epoch-99-avg-1.onnx`,
        joiner: `${modelDir}/joiner-epoch-99-avg-1.int8.onnx`,
      },
      tokens: `${modelDir}/tokens.txt`,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });

  const transcriptLines = readFileSync(`${modelDir}/test_wavs/transcript.txt`, "utf-8")
    .trim()
    .split("\n");

  let allOk = true;
  for (const line of transcriptLines) {
    const [filename, ...rest] = line.split(" ");
    const expected = rest.join(" ");
    const wavPath = `${modelDir}/test_wavs/${filename}`;

    const wave = sherpa_onnx.readWave(wavPath);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });

    const started = Date.now();
    recognizer.decode(stream);
    const elapsedMs = Date.now() - started;
    const result = recognizer.getResult(stream);

    const durationSec = wave.samples.length / wave.sampleRate;
    const rtf = elapsedMs / 1000 / durationSec;

    console.log(`--- ${filename} (${durationSec.toFixed(1)}s, RTF=${rtf.toFixed(3)}) ---`);
    console.log(`  正解: ${expected}`);
    console.log(`  認識: ${result.text}`);

    // 句読点や表記揺れがあるため完全一致は求めず、大まかに近いかだけ見る
    const similar =
      result.text.length > 0 &&
      [...expected].filter((c) => result.text.includes(c)).length / expected.length > 0.5;
    console.log(`  ${similar ? "OK" : "NG(要目視確認)"}\n`);
    if (!similar) allOk = false;
  }

  // TTS(VOICEVOX)→STTの閉ループ確認。24kHzで生成される点が
  // モデルの想定(16kHz)と異なるため、sherpa-onnx側の内部リサンプルが
  // 効いているかもここで確認できる。
  try {
    const ttsWavPath = "output/tts-test.wav";
    const wave = sherpa_onnx.readWave(ttsWavPath);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    console.log(`--- TTS→STT閉ループ (${ttsWavPath}, ${wave.sampleRate}Hz) ---`);
    console.log(`  期待: こんにちはなのだ (付近)`);
    console.log(`  認識: ${result.text}\n`);
  } catch (err) {
    console.log(`  (閉ループ確認スキップ: ${err instanceof Error ? err.message : err})\n`);
  }

  console.log(allOk ? "=== 疎通テスト成功 ===" : "=== 一部認識結果がずれている可能性あり(上記ログ参照) ===");
}

main().catch((err) => {
  console.error("✗ STT疎通テストに失敗しました:", err);
  process.exit(1);
});
