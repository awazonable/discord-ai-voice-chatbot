import OpenAI from "openai";
import { loadConfig, describeConfig, MissingApiKeyError } from "./config.js";
import { OpenAILLMClient } from "./llm/openaiClient.js";

/**
 * 実APIテストの前に、構成が本当に通るかを最小コストで確認する。
 *
 * PoCのモデル名は仮称のため、まず /v1/models で「そのキーで実際に
 * 使えるモデル」を取得し、設定値がその中にあるかを照合する。
 * 無ければ候補を提示して終了する（本番モデルに投げて課金する前に止める）。
 */

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof MissingApiKeyError) fail(err.message);
    throw err;
  }

  console.log("=== プリフライト ===");
  console.log(describeConfig(cfg));
  console.log();

  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });

  // --- 1. 認証とモデル一覧 ---------------------------------------------
  let available: string[];
  try {
    const list = await client.models.list();
    available = list.data.map((m) => m.id).sort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      `モデル一覧の取得に失敗しました（認証/ネットワークの問題の可能性）:\n  ${msg}`
    );
  }

  console.log(`✓ 認証成功。利用可能なモデル ${available.length} 件`);

  // チャット系で絞れなければ全件出す（OpenAI互換の別サーバでは
  // gpt- 始まりでないモデル名も普通にあるため）
  const chatLike = available.filter((id) => /^(gpt|o\d|chatgpt)/.test(id));
  const candidates = chatLike.length > 0 ? chatLike : available;
  console.log(
    chatLike.length > 0 ? "  チャット系モデルの候補:" : "  モデル一覧:"
  );
  for (const id of candidates.slice(0, 40)) console.log(`    - ${id}`);
  if (candidates.length > 40)
    console.log(`    ... 他 ${candidates.length - 40} 件`);
  console.log();

  // --- 2. 設定されたモデル名の照合 --------------------------------------
  const missing = [
    ["MAIN_MODEL", cfg.mainModel],
    ["JUDGE_MODEL", cfg.judgeModel],
  ].filter(([, id]) => !available.includes(id!));

  if (missing.length > 0) {
    console.error("✗ 設定されたモデル名がこのキーでは利用できません:");
    for (const [k, id] of missing) console.error(`    ${k}=${id}`);
    console.error(
      "\n  上の候補一覧から実在するモデル名を選び、.env の MAIN_MODEL /" +
        " JUDGE_MODEL を書き換えてから再実行してください。"
    );
    console.error(
      "  （PoC既定の gpt-5.6-sol / gpt-5.6-luna は設計時の仮称です）"
    );
    process.exit(1);
  }
  console.log(`✓ MAIN_MODEL=${cfg.mainModel} / JUDGE_MODEL=${cfg.judgeModel} は利用可能`);
  console.log();

  const llm = new OpenAILLMClient({
    apiKey: cfg.apiKey,
    mainModel: cfg.mainModel,
    judgeModel: cfg.judgeModel,
    baseURL: cfg.baseURL,
  });

  // --- 3. ストリーミング疎通 + 初トークンまでのレイテンシ ----------------
  // 先行投機実行の設計は「初トークンが猶予ウィンドウ(2秒)内に返ること」を
  // 暗黙に前提にしているため、ここで実測しておく。
  const ctrl = new AbortController();
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let text = "";

  try {
    for await (const tok of llm.streamChat(
      [{ role: "user", content: "「テストなのだ」とだけ返してください。" }],
      ctrl.signal
    )) {
      if (tok.text && firstTokenMs === null) firstTokenMs = Date.now() - started;
      text += tok.text;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`本体モデルのストリーミング呼び出しに失敗しました:\n  ${msg}`);
  }

  const totalMs = Date.now() - started;
  console.log(`✓ streamChat 疎通OK`);
  console.log(`    初トークンまで: ${firstTokenMs ?? totalMs}ms / 全体: ${totalMs}ms`);
  console.log(`    応答: ${JSON.stringify(text.slice(0, 80))}`);
  if ((firstTokenMs ?? totalMs) > 2000) {
    console.log(
      "    ⚠ 初トークンが猶予ウィンドウ(2000ms)より遅いです。" +
        "先行投機実行の前提が崩れるため GRACE_WINDOW_MS の見直しを検討してください。"
    );
  }
  console.log();

  // --- 4. 判定モデルの疎通 + JSONモード確認 -----------------------------
  const judgeStart = Date.now();
  try {
    const res = await llm.judgeContinuation(
      [{ role: "user", content: "ずんだもん、明日の天気は？" }],
      "やっぱりいいや、遠足の話がしたい",
      new AbortController().signal
    );
    console.log(`✓ judgeContinuation 疎通OK (${Date.now() - judgeStart}ms)`);
    console.log(`    isContinuation=${res.isContinuation}`);
    console.log(`    reasoning=${JSON.stringify(res.reasoning.slice(0, 120))}`);
    if (res.reasoning.startsWith("判定応答のパースに失敗")) {
      console.log(
        "    ⚠ JSONとしてパースできませんでした。JUDGE_MODEL が" +
          " response_format=json_object に対応しているか確認してください。"
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`判定モデルの呼び出しに失敗しました:\n  ${msg}`);
  }

  console.log("\n=== プリフライト成功。`npm run scenarios:real` を実行できます ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
