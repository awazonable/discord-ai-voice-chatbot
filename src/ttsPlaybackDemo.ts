import { OpenAILLMClient } from "./llm/openaiClient.js";
import { ZundamonSession } from "./session/zundamonSession.js";
import { SushikiTTSClient, findZundamonSpeakerId } from "./tts/sushikiClient.js";
import { RealPlaybackQueue } from "./tts/playbackQueue.js";
import {
  loadConfig,
  describeConfig,
  MissingApiKeyError,
  MissingSushikiApiKeyError,
} from "./config.js";
import type { Utterance } from "./session/types.js";

/**
 * onSentenceReady を実物の音声合成+スピーカー再生につなぎ込んで、
 * 実際に音が鳴ること・audioClockの0.1秒/文字という概算が実測とどれくらい
 * ズレているかを確認する。あわせて、グレースフル中断が実際に鳴っている
 * 音声も止められているか（onAudioTruncated -> RealPlaybackQueue.truncatePending）
 * を目視・耳で確認する。
 *
 * コストを抑えるため、S3シナリオ(遠足の持ち物10個)より短い題材を使う。
 */

const ESTIMATED_SEC_PER_CHAR = 0.1; // audioClock.ts と同じ値

function utt(text: string): Utterance {
  return { text, speakerId: "playback-demo", timestamp: Date.now() };
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (!cfg.sushikiApiKey) throw new MissingSushikiApiKeyError();

  console.log("=== 実音声再生つき セッションデモ ===");
  console.log(describeConfig(cfg));
  console.log();

  const llm = new OpenAILLMClient({
    apiKey: cfg.apiKey,
    mainModel: cfg.mainModel,
    judgeModel: cfg.judgeModel,
    baseURL: cfg.baseURL,
  });
  const tts = new SushikiTTSClient({ apiKey: cfg.sushikiApiKey });

  console.log("話者一覧を取得中...");
  const speakers = await tts.listSpeakers();
  const speakerId = findZundamonSpeakerId(speakers) ?? 3;
  console.log(`speaker=${speakerId} を使用\n`);

  const queue = new RealPlaybackQueue({
    tts,
    speaker: speakerId,
    onSentenceStart: (text) => {
      console.log(`  🔊 再生開始: "${text}"`);
    },
    onSentenceDone: (text, measuredMs) => {
      const estimatedMs = text.length * ESTIMATED_SEC_PER_CHAR * 1000;
      console.log(
        `  ✓ 再生完了 (${text.length}文字) 見積り=${estimatedMs.toFixed(0)}ms ` +
          `実測=${measuredMs}ms 差=${(measuredMs - estimatedMs).toFixed(0)}ms`
      );
    },
    onError: (err, text) => {
      console.error(`  ✗ 再生エラー ("${text}"):`, err);
    },
  });

  let sentenceCount = 0;
  let followupFired = false;

  const session = new ZundamonSession(llm, {
    onPrimaryResponsePlay: (p) => console.log(`[一次応答] ${p}`),
    onSentenceReady: (s) => {
      sentenceCount++;
      console.log(`[文${sentenceCount}完成→再生キュー] ${s}`);
      queue.enqueue(s);

      // 1文目の再生開始と同時に割り込み発話を注入する
      // （実際の音声がまだ流れている最中に割り込ませたいため）
      if (sentenceCount === 1 && !followupFired) {
        followupFired = true;
        console.log('  >>> 追加発話を注入: "やっぱりいいや、今何時なのだ？"');
        void session
          .onFinalUtterance(utt("やっぱりいいや、今何時なのだ？"))
          .catch((e) => console.error("[注入エラー]", e));
      }
    },
    onSpeechInterrupted: (r) => console.log(`[中断要求] ${r}`),
    onAudioTruncated: (n, chars, savedMs) => {
      const removed = queue.truncatePending();
      console.log(
        `[音声破棄] シミュレーション上は${n}文(${chars}文字, 約${(savedMs / 1000).toFixed(1)}s分)を破棄` +
          ` / 実キューからも${removed}件削除`
      );
    },
    onFinalResponse: (t) => console.log(`[最終応答] ${t}`),
    onStateChange: (st) => console.log(`(state -> ${st})`),
    onError: (err, ctx) => console.error(`[エラー: ${ctx}]`, err),
  });

  console.log('起動発話: "ずんだもん、遠足の持ち物を5個、順番に説明して"\n');
  await session.onFinalUtterance(utt("ずんだもん、遠足の持ち物を5個、順番に説明して"));

  // セッション(テキスト)はIDLEに戻っても、実際の音声再生キューは
  // まだ残っている可能性がある（これ自体がaudioClockで扱っている
  // ズレそのもの）。両方が終わるまでポーリングで待つ。
  while (session.getState() !== "IDLE" || sentenceCount === 0 || queue.isBusy()) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("\n=== デモ終了 ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ デモの実行に失敗しました:", err);
  process.exit(1);
});
