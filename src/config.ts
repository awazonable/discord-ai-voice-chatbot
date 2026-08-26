import "dotenv/config";

/**
 * モデル名について:
 *
 * PoC作成時点の `gpt-5.6-sol` / `gpt-5.6-luna` は暫定の仮称であり、
 * 実際にAPIで通る保証はない。ここではハードコードされた「正解」を
 * 埋め込まず、.env の値をそのまま使う。
 * 実在するモデル名は `npm run preflight` が /v1/models を叩いて
 * 確認・提示する。
 */
export const DEFAULT_MAIN_MODEL = "gpt-5.6-sol";
export const DEFAULT_JUDGE_MODEL = "gpt-5.6-luna";

export interface AppConfig {
  apiKey: string;
  mainModel: string;
  judgeModel: string;
  baseURL?: string;
  /** su-shiki.com が提供するWeb版VOICEVOX APIのキー。音声合成の検証時のみ必要。 */
  sushikiApiKey?: string;
}

export class MissingSushikiApiKeyError extends Error {
  constructor() {
    super(
      "環境変数 SUSHIKI_API_KEY が設定されていません。\n" +
        "  https://su-shiki.com/api/ でキーを取得し .env に設定してください。"
    );
    this.name = "MissingSushikiApiKeyError";
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "環境変数 OPENAI_API_KEY が設定されていません。\n" +
        "  cp .env.example .env  してから .env にキーを記入してください。\n" +
        "  （OpenAI互換のローカルサーバを使う場合は OPENAI_BASE_URL を設定し、\n" +
        "    OPENAI_API_KEY にはダミー値を入れてください）"
    );
    this.name = "MissingApiKeyError";
  }
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  return {
    apiKey,
    mainModel: process.env.MAIN_MODEL ?? DEFAULT_MAIN_MODEL,
    judgeModel: process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    sushikiApiKey: process.env.SUSHIKI_API_KEY || undefined,
  };
}

/** 実行前にどの構成で叩くのかを必ず表示する（課金事故の予防） */
export function describeConfig(cfg: AppConfig): string {
  return [
    `  endpoint   : ${cfg.baseURL ?? "https://api.openai.com/v1 (本番)"}`,
    `  main model : ${cfg.mainModel}`,
    `  judge model: ${cfg.judgeModel}`,
    `  api key    : ${cfg.apiKey.slice(0, 7)}...(${cfg.apiKey.length} chars)`,
  ].join("\n");
}
