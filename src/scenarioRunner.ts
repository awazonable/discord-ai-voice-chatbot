import { ZundamonSession } from "./session/zundamonSession.js";
import type { Utterance } from "./session/types.js";
import type { LLMClient } from "./llm/types.js";

/**
 * 実API（またはOpenAI互換サーバ）に対して、対話入力なしで
 * 再現可能なシナリオを流すテストランナー。
 *
 * cli.ts の手入力だと「ストリーミング中に割り込む」タイミングが
 * 人間の打鍵速度に依存して再現しない。ここでは固定sleepではなく
 * 「N文目が完成した瞬間」をトリガに追加発話を注入するため、
 * 応答速度が変わっても狙った経路を通せる。
 */

type Trigger =
  | { kind: "afterSentence"; index: number }
  | { kind: "afterFinal" }
  | { kind: "afterMs"; ms: number };

/**
 * 追加発話が処理される経路は2つあり、どちらを通るかは
 * 「判定LLMの往復時間」と「本体応答の残り長さ」の大小で決まる。
 *  - interrupt : 判定が返った時点でまだ喋っている → 文単位グレースフル中断
 *  - newRound  : 判定が返る前に喋り終わっていた   → そのまま次ラウンド
 * どちらも正しい挙動なので、シナリオごとに期待経路を明示する。
 */
export type FollowupPath = "interrupt" | "newRound" | "ignored";

export interface Scenario {
  name: string;
  purpose: string;
  wake: string;
  followup?: { text: string; at: Trigger };
  /** 許容する経路。実測がここに含まれなければFAIL。 */
  expectPaths: FollowupPath[];
  /** 応答が途中で止まるのを待つ最大時間 */
  timeoutMs?: number;
  /** IDLEがこの時間続いたらシナリオ完了とみなす。判定往復より長くとる。 */
  quietMs?: number;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "S1 単独の呼びかけ",
    purpose: "追加発話なし。最後まで喋り切って IDLE に戻ること。",
    wake: "ずんだもん、明日の天気は？",
    expectPaths: [],
  },
  {
    name: "S2 無関係な追加発話",
    purpose:
      "無関係な発話は continuation=false と判定され、応答が中断されないこと。",
    wake: "ずんだもん、明日の天気は？",
    followup: {
      text: "そういえば昨日の試合見た？",
      at: { kind: "afterSentence", index: 1 },
    },
    expectPaths: ["ignored"],
  },
  {
    name: "S3 関連する追加発話（グレースフル中断）",
    purpose:
      "長い応答の途中で関連発話が入り、今の文を言い切ってから第2ラウンドへ移ること。",
    // 判定LLMの往復(数百ms〜数秒)より応答が長くないと中断経路に入らないため、
    // 意図的に長い応答を誘発する問いにしている。
    wake:
      "ずんだもん、長い話をして。遠足の持ち物を10個、ひとつずつ順番に説明して。",
    followup: {
      text: "やっぱりいいや、明日の天気を教えて",
      at: { kind: "afterSentence", index: 1 },
    },
    expectPaths: ["interrupt"],
  },
  {
    name: "S4 応答完了後の追加発話",
    purpose:
      "判定が返る頃にはラウンドが終わっているケース。発話が握り潰されず新ラウンドが走ること。",
    wake: "ずんだもん、こんにちは。",
    followup: { text: "ついでに自己紹介して", at: { kind: "afterFinal" } },
    expectPaths: ["newRound"],
  },
];

function utt(text: string): Utterance {
  return { text, speakerId: "scenario-runner", timestamp: Date.now() };
}

export async function runScenario(
  llm: LLMClient,
  sc: Scenario
): Promise<boolean> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${sc.name}`);
  console.log(`  ねらい: ${sc.purpose}`);
  console.log("=".repeat(70));

  const quietMs = sc.quietMs ?? 2500;

  let sentenceCount = 0;
  let interrupted = false;
  let roundsStarted = 0;
  let finalCount = 0;
  let sawError = false;
  let followupFired = false;
  let judgedContinuation: boolean | null = null;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  // IDLE になっても、判定がまだ飛行中で新ラウンドが始まる可能性がある。
  // 状態が動くたびにタイマーを張り直し、「静止」を待ってから完了とする。
  let quietTimer: NodeJS.Timeout | null = null;
  const bumpQuiet = (active: boolean) => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = null;
    if (active) return;
    if (sc.followup && !followupFired) return;
    quietTimer = setTimeout(() => resolveDone(), quietMs);
  };

  const fireFollowup = () => {
    if (!sc.followup || followupFired) return;
    followupFired = true;
    console.log(`  >>> 追加発話を注入: "${sc.followup.text}"`);
    void session.onFinalUtterance(utt(sc.followup.text)).catch((e) => {
      sawError = true;
      console.error("  [注入エラー]", e);
    });
  };

  const session = new ZundamonSession(llm, {
    onPrimaryResponsePlay: (p) => console.log(`  [一次応答] ${p}`),
    onSentenceReady: (s) => {
      sentenceCount++;
      console.log(`  [文${sentenceCount}→VOICEVOX] ${s}`);
      if (
        sc.followup?.at.kind === "afterSentence" &&
        sentenceCount === sc.followup.at.index
      ) {
        fireFollowup();
      }
    },
    onSpeechInterrupted: (r) => {
      interrupted = true;
      console.log(`  [中断要求] ${r}`);
    },
    onAudioTruncated: (n, chars, savedMs) => {
      console.log(
        `  [音声破棄] 未再生の${n}文(${chars}文字、音声換算${(savedMs / 1000).toFixed(1)}s分)を` +
          `キューから破棄`
      );
    },
    onFinalResponse: (t) => {
      finalCount++;
      console.log(`  [最終応答${finalCount}] ${t}`);
      if (sc.followup?.at.kind === "afterFinal" && finalCount === 1) {
        fireFollowup();
      }
    },
    onStateChange: (st) => {
      if (st === "PROCESSING") roundsStarted++;
      console.log(`  (state -> ${st})`);
      bumpQuiet(st !== "IDLE");
    },
    onError: (err, ctx) => {
      sawError = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [エラー: ${ctx}] ${msg}`);
      resolveDone();
    },
    onJudge: (isContinuation) => {
      judgedContinuation = isContinuation;
      // 判定が返っただけではまだ新ラウンドが立つ可能性があるので静止待ちを延長
      bumpQuiet(true);
      bumpQuiet(session.getState() !== "IDLE");
    },
  });

  void session.onFinalUtterance(utt(sc.wake)).catch((e) => {
    sawError = true;
    console.error("  [起動エラー]", e);
  });

  if (sc.followup?.at.kind === "afterMs") {
    setTimeout(fireFollowup, sc.followup.at.ms);
  }

  const outcome = await Promise.race([
    done.then(() => "done" as const),
    new Promise<"timeout">((r) =>
      setTimeout(() => r("timeout"), sc.timeoutMs ?? 90000)
    ),
  ]);
  if (quietTimer) clearTimeout(quietTimer);

  // どの経路を通ったかを実測から判定する
  let actualPath: FollowupPath | null = null;
  if (sc.followup) {
    if (judgedContinuation === false) actualPath = "ignored";
    else if (interrupted) actualPath = "interrupt";
    else if (roundsStarted >= 2) actualPath = "newRound";
  }

  const finalState = session.getState();
  console.log(
    `  --- 実測: outcome=${outcome} state=${finalState} 文数=${sentenceCount} ` +
      `ラウンド数=${roundsStarted} 最終応答=${finalCount} 経路=${actualPath ?? "なし"}`
  );

  const pathOk =
    sc.expectPaths.length === 0
      ? actualPath === null
      : actualPath !== null && sc.expectPaths.includes(actualPath);

  const ok =
    outcome === "done" &&
    !sawError &&
    finalState === "IDLE" &&
    sentenceCount > 0 &&
    pathOk;

  if (!pathOk) {
    console.log(
      `  !!! 期待経路=${sc.expectPaths.join("|") || "なし"} / 実測経路=${actualPath ?? "なし"}`
    );
    if (sc.expectPaths.includes("interrupt") && actualPath === "newRound") {
      console.log(
        "      → 判定LLMの往復時間が本体応答の長さを上回ったため中断経路に入らなかった。\n" +
          "        グレースフル中断は「判定が返る時点でまだ喋っている」ときだけ意味を持つ。"
      );
    }
  }
  console.log(`  --- ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

/** 全シナリオを順に実行し、失敗数を返す */
export async function runAllScenarios(llm: LLMClient): Promise<number> {
  const results: Array<[string, boolean]> = [];
  for (const sc of SCENARIOS) {
    results.push([sc.name, await runScenario(llm, sc)]);
  }

  console.log(`\n${"=".repeat(70)}\n結果まとめ`);
  for (const [name, ok] of results) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(`${"=".repeat(70)}`);
  return results.filter(([, ok]) => !ok).length;
}
