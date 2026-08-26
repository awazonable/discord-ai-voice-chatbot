import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { findZundamonSpeakerId } from "./tts/sushikiClient.js";
import { createTTSClient, describeTTSConfig } from "./tts/createTTSClient.js";

/**
 * 音声合成の単発疎通テスト（ローカルVOICEVOX優先、無ければsu-shiki）。
 * 話者一覧を取得し、可能なら「ずんだもん / ノーマル」を選んで、
 * 短い文を実際に合成してファイルに保存する（耳で確認できるように）。
 */

const TEST_TEXT = "こんにちはなのだ";

function extFromContentType(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("ogg")) return "ogg";
  return "bin";
}

async function main() {
  const cfg = loadConfig();
  const client = createTTSClient(cfg);

  console.log("=== TTS 疎通テスト ===");
  console.log(describeTTSConfig(cfg));
  console.log(`  test text: "${TEST_TEXT}" (${TEST_TEXT.length}文字)`);
  if (!cfg.voicevoxBaseURL) {
    console.log(
      `  概算コスト: 1500 + 100×${TEST_TEXT.length} = ${1500 + 100 * TEST_TEXT.length} ポイント` +
        "（su-shiki公式ドキュメント記載の計算式より。話者一覧取得は別途）"
    );
  }
  console.log();

  console.log("[1] 話者一覧を取得中...");
  let speakerId = 3; // ローカルVOICEVOXの慣例上「ずんだもん ノーマル」が3のことが多いが未確認のフォールバック
  try {
    const speakers = await client.listSpeakers();
    console.log(`  ✓ ${speakers.length}件の話者を取得`);

    const found = findZundamonSpeakerId(speakers);
    if (found !== null) {
      speakerId = found;
      console.log(`  ✓ ずんだもんを発見: speaker=${found} を使用`);
    } else {
      console.log(
        `  ⚠ 話者一覧に「ずんだもん」が見つからなかったため、既定値 speaker=${speakerId} を使用`
      );
      console.log(
        `    取得できた話者名: ${speakers.map((s) => s.name).join(", ") || "(なし)"}`
      );
    }
  } catch (err) {
    console.log(`  ⚠ 話者一覧の取得に失敗（続行して既定値で合成を試みる）:`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log();

  console.log(`[2] 合成中... (speaker=${speakerId})`);
  const started = Date.now();
  const { audio, contentType } = await client.synthesize(TEST_TEXT, {
    speaker: speakerId,
  });
  const elapsedMs = Date.now() - started;

  const ext = extFromContentType(contentType);
  mkdirSync("output", { recursive: true });
  const outPath = `output/tts-test.${ext}`;
  writeFileSync(outPath, audio);

  console.log(`  ✓ 合成成功 (${elapsedMs}ms)`);
  console.log(`    content-type: ${contentType}`);
  console.log(`    サイズ: ${audio.length} bytes`);
  console.log(`    保存先: ${outPath}`);
  console.log();
  console.log("=== 疎通テスト成功 ===");
}

main().catch((err) => {
  console.error("✗ TTS疎通テストに失敗しました:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
