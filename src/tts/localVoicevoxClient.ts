import type {
  Speaker,
  SynthesizeOptions,
  SynthesizeResult,
  TTSClient,
} from "./types.js";
import { parseSpeakers, TTSError } from "./sushikiClient.js";

export interface LocalVoicevoxClientOptions {
  /** ローカルVOICEVOXエンジンのベースURL。既定は標準の起動ポート。 */
  baseURL?: string;
  defaultSpeaker?: number;
}

/**
 * ローカルで起動したVOICEVOXエンジン(REST API)のクライアント。
 * su-shiki(Web版API)と違い、1回のリクエストでは完結せず
 * 「audio_query(パラメータ生成)→synthesis(音声合成)」の2段階を踏む
 * のがVOICEVOXエンジンの標準的な使い方。ポイント消費・レート制限が
 * 無く、ローカルで完結するため開発中の反復に向く。
 */
export class LocalVoicevoxClient implements TTSClient {
  private baseURL: string;

  constructor(private opts: LocalVoicevoxClientOptions = {}) {
    this.baseURL = (opts.baseURL ?? "http://127.0.0.1:50021").replace(/\/$/, "");
  }

  async synthesize(
    text: string,
    synthOpts: SynthesizeOptions = {}
  ): Promise<SynthesizeResult> {
    const speaker = synthOpts.speaker ?? this.opts.defaultSpeaker ?? 3;

    const queryUrl = new URL(`${this.baseURL}/audio_query`);
    queryUrl.searchParams.set("text", text);
    queryUrl.searchParams.set("speaker", String(speaker));

    const queryRes = await fetch(queryUrl, { method: "POST" });
    if (!queryRes.ok) {
      const body = await queryRes.text();
      throw new TTSError(
        `audio_queryに失敗しました (status=${queryRes.status}): ${body.slice(0, 300)}`
      );
    }
    const query = (await queryRes.json()) as Record<string, unknown>;

    if (synthOpts.speed !== undefined) query.speedScale = synthOpts.speed;
    if (synthOpts.pitch !== undefined) query.pitchScale = synthOpts.pitch;
    if (synthOpts.intonationScale !== undefined) {
      query.intonationScale = synthOpts.intonationScale;
    }

    const synthUrl = new URL(`${this.baseURL}/synthesis`);
    synthUrl.searchParams.set("speaker", String(speaker));

    const synthRes = await fetch(synthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });

    const contentType = synthRes.headers.get("content-type") ?? "";
    const bodyBuf = Buffer.from(await synthRes.arrayBuffer());

    if (!synthRes.ok || !contentType.startsWith("audio/")) {
      const bodyText = bodyBuf.toString("utf-8");
      throw new TTSError(
        `synthesisに失敗しました (status=${synthRes.status}, content-type="${contentType}"): ` +
          bodyText.slice(0, 300)
      );
    }

    return { audio: bodyBuf, contentType };
  }

  async listSpeakers(): Promise<Speaker[]> {
    const res = await fetch(`${this.baseURL}/speakers`);
    const bodyText = await res.text();
    if (!res.ok) {
      throw new TTSError(
        `話者一覧の取得に失敗しました (status=${res.status}): ${bodyText.slice(0, 300)}`
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      throw new TTSError(
        `話者一覧のレスポンスがJSONとして解釈できませんでした: ${bodyText.slice(0, 300)}`
      );
    }
    return parseSpeakers(raw);
  }
}
