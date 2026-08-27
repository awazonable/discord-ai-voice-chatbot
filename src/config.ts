import "dotenv/config";
import {
  DEFAULT_WAKE_WORD_CONFIG,
  validateWakeWordConfig,
  type WakeWordConfig,
} from "./session/wakeword.js";

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

type Environment = Readonly<Record<string, string | undefined>>;

export type SearchConfig =
  | { backend: "disabled" }
  | {
      backend: "searxng";
      baseURL: string;
      timeoutMs: number;
      maxResults: number;
    }
  | {
      backend: "openai";
      model: string;
      timeoutMs: number;
      maxResults: number;
    };

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} は1〜${maximum}の整数で指定してください。`);
  }
  return parsed;
}

export function loadSearchConfig(
  env: Environment = process.env,
  mainModel = env.MAIN_MODEL ?? DEFAULT_MAIN_MODEL,
): SearchConfig {
  const backend = (env.WEB_SEARCH_BACKEND ?? "searxng").trim().toLowerCase();
  if (backend === "disabled") return { backend };

  const timeoutMs = parsePositiveInteger(
    env.WEB_SEARCH_TIMEOUT_MS,
    7_000,
    "WEB_SEARCH_TIMEOUT_MS",
    60_000,
  );
  const maxResults = parsePositiveInteger(
    env.WEB_SEARCH_MAX_RESULTS,
    5,
    "WEB_SEARCH_MAX_RESULTS",
    10,
  );

  if (backend === "searxng") {
    const baseURL = env.SEARXNG_URL?.trim() || "http://127.0.0.1:8080";
    let parsed: URL;
    try {
      parsed = new URL(baseURL);
    } catch {
      throw new Error("SEARXNG_URL は有効なURLで指定してください。");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("SEARXNG_URL は認証情報を含まないHTTP(S) URLで指定してください。");
    }
    return {
      backend,
      baseURL: parsed.toString().replace(/\/$/, ""),
      timeoutMs,
      maxResults,
    };
  }

  if (backend === "openai") {
    return {
      backend,
      model: env.WEB_SEARCH_MODEL?.trim() || mainModel,
      timeoutMs,
      maxResults,
    };
  }

  throw new Error(
    "WEB_SEARCH_BACKEND は searxng / openai / disabled のいずれかを指定してください。",
  );
}

function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const values = [
    ...new Set(value.split(",").map((item) => item.trim()).filter(Boolean)),
  ];
  return values.length > 0 ? values : undefined;
}

/**
 * .envからウェイクワード語彙を読み込む。
 *
 * WAKE_WORDS自体が未指定なら、既定の名前とそのASR別名をまとめて使う。
 * WAKE_WORDSを明示して名前を置き換えた場合は、既定キャラクター固有の
 * ASR別名が残らないよう、weak/ambiguousは明示された値だけを使う。
 */
export function loadWakeWordConfig(env: Environment = process.env): WakeWordConfig {
  const configuredCanonical = parseCommaSeparated(env.WAKE_WORDS);
  const useDefaultVocabulary = configuredCanonical === undefined;
  const config: WakeWordConfig = {
    ...DEFAULT_WAKE_WORD_CONFIG,
    canonical: configuredCanonical ?? DEFAULT_WAKE_WORD_CONFIG.canonical,
    weak:
      parseCommaSeparated(env.WAKE_WORD_WEAK_ALIASES) ??
      (useDefaultVocabulary ? DEFAULT_WAKE_WORD_CONFIG.weak : []),
    ambiguous:
      parseCommaSeparated(env.WAKE_WORD_AMBIGUOUS_ALIASES) ??
      (useDefaultVocabulary ? DEFAULT_WAKE_WORD_CONFIG.ambiguous : []),
    attentionCues:
      parseCommaSeparated(env.WAKE_ATTENTION_CUES) ?? DEFAULT_WAKE_WORD_CONFIG.attentionCues,
  };
  validateWakeWordConfig(config);
  return config;
}

export interface AppConfig {
  apiKey: string;
  mainModel: string;
  judgeModel: string;
  baseURL?: string;
  /** su-shiki.com が提供するWeb版VOICEVOX APIのキー。音声合成の検証時のみ必要。 */
  sushikiApiKey?: string;
  /**
   * ローカルVOICEVOXエンジンのベースURL。設定されていれば
   * su-shiki(Web API)より優先してこちらを使う（ポイント消費・レート制限が
   * 無く開発中の反復に向くため）。
   *   例: VOICEVOX_BASE_URL=http://127.0.0.1:50021
   */
  voicevoxBaseURL?: string;
  /** ローカルQdrantのURL。長期記憶(ベクトルDB)に使う。既定はローカル標準ポート。 */
  qdrantURL: string;
  /** 長期記憶のベクトル化に使う埋め込みモデル。 */
  embeddingModel: string;
  /** sherpa-onnx用モデル一式を置くディレクトリ。既定は .models/ 。 */
  modelsDir: string;
  wakeWordConfig: WakeWordConfig;
  search: SearchConfig;
  discord?: {
    botToken: string;
    devGuildId?: string;
    devChannelIdText?: string;
    devChannelIdVoice?: string;
    devUserIdAdmin?: string;
  };
}

export class MissingDiscordTokenError extends Error {
  constructor() {
    super(
      "環境変数 DISCORD_BOT_TOKEN が設定されていません。\n" +
        "  Discord Developer Portal でBotを作成し、.env に設定してください。"
    );
    this.name = "MissingDiscordTokenError";
  }
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

  const mainModel = process.env.MAIN_MODEL ?? DEFAULT_MAIN_MODEL;
  return {
    apiKey,
    mainModel,
    judgeModel: process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    sushikiApiKey: process.env.SUSHIKI_API_KEY || undefined,
    voicevoxBaseURL: process.env.VOICEVOX_BASE_URL || undefined,
    qdrantURL: process.env.QDRANT_URL || "http://127.0.0.1:6333",
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    modelsDir: process.env.MODELS_DIR || ".models",
    wakeWordConfig: loadWakeWordConfig(),
    search: loadSearchConfig(process.env, mainModel),
    discord: process.env.DISCORD_BOT_TOKEN
      ? {
          botToken: process.env.DISCORD_BOT_TOKEN,
          devGuildId: process.env.DEV_GUILD_ID || undefined,
          devChannelIdText: process.env.DEV_CHANNEL_ID_TEXT || undefined,
          devChannelIdVoice: process.env.DEV_CHANNEL_ID_VOICE || undefined,
          devUserIdAdmin: process.env.DEV_USER_ID_ADMIN || undefined,
        }
      : undefined,
  };
}

/** 実行前にどの構成で叩くのかを必ず表示する（課金事故の予防） */
export function describeConfig(cfg: AppConfig): string {
  return [
    `  endpoint   : ${cfg.baseURL ?? "https://api.openai.com/v1 (本番)"}`,
    `  main model : ${cfg.mainModel}`,
    `  judge model: ${cfg.judgeModel}`,
    `  api key    : ${cfg.apiKey.slice(0, 7)}...(${cfg.apiKey.length} chars)`,
    `  wake words : ${cfg.wakeWordConfig.canonical.join(", ")}`,
    `  web search : ${
      cfg.search.backend === "searxng"
        ? `SearXNG (${cfg.search.baseURL})`
        : cfg.search.backend === "openai"
          ? `OpenAI (${cfg.search.model})`
          : "無効"
    }`,
  ].join("\n");
}
