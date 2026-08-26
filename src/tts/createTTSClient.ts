import type { AppConfig } from "../config.js";
import type { TTSClient } from "./types.js";
import { SushikiTTSClient } from "./sushikiClient.js";
import { LocalVoicevoxClient } from "./localVoicevoxClient.js";

/**
 * .env の設定から使うTTS実装を選ぶ。VOICEVOX_BASE_URL（ローカルエンジン）が
 * 設定されていればそちらを優先する。su-shiki(Web API)はポイント消費・
 * レート制限があるため、ローカルが使えるなら開発中はローカルを使うべき。
 */
export function createTTSClient(cfg: AppConfig): TTSClient {
  if (cfg.voicevoxBaseURL) {
    return new LocalVoicevoxClient({ baseURL: cfg.voicevoxBaseURL });
  }
  if (cfg.sushikiApiKey) {
    return new SushikiTTSClient({ apiKey: cfg.sushikiApiKey });
  }
  throw new Error(
    "TTSクライアントを作成できません。.env に VOICEVOX_BASE_URL" +
      "（ローカルVOICEVOXエンジン、例: http://127.0.0.1:50021）か" +
      "SUSHIKI_API_KEY（su-shiki Web API）のどちらかを設定してください。"
  );
}

export function describeTTSConfig(cfg: AppConfig): string {
  if (cfg.voicevoxBaseURL) {
    return `  tts        : ローカルVOICEVOX (${cfg.voicevoxBaseURL})`;
  }
  if (cfg.sushikiApiKey) {
    return `  tts        : su-shiki Web API`;
  }
  return `  tts        : (未設定)`;
}
