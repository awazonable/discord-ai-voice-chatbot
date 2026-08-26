import type {
  SpeakerStyle,
  Speaker,
  SynthesizeOptions,
  SynthesizeResult,
  TTSClient,
} from "./types.js";

const AUDIO_URL = "https://deprecatedapis.tts.quest/v2/voicevox/audio/";
const SPEAKERS_URL = "https://deprecatedapis.tts.quest/v2/voicevox/speakers/";

export class TTSError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TTSError";
  }
}

export interface SushikiClientOptions {
  apiKey: string;
  /** 話者IDを明示しなかったときに使う既定値。 */
  defaultSpeaker?: number;
}

/**
 * su-shiki.com が提供するWeb版VOICEVOX API
 * （実体は https://deprecatedapis.tts.quest/v2/voicevox/ ）のクライアント。
 *
 * ローカルVOICEVOXエンジンではなくWeb API経由のため、テキストの文字数に
 * 応じてポイントが消費される（公式ドキュメントいわく
 * 「1500 + 100×UTF-8文字数」）。呼び出しのたびに課金相当のコストが
 * かかる点は openai/config.ts の「課金事故の予防」と同じ扱いにしている。
 *
 * レスポンスの音声フォーマットが公式ドキュメントに明記されていないため、
 * 決め打ちせずContent-Typeヘッダから実測して返す。
 */
export class SushikiTTSClient implements TTSClient {
  constructor(private opts: SushikiClientOptions) {}

  async synthesize(
    text: string,
    synthOpts: SynthesizeOptions = {}
  ): Promise<SynthesizeResult> {
    const params = new URLSearchParams();
    params.set("key", this.opts.apiKey);
    params.set("text", text);
    params.set(
      "speaker",
      String(synthOpts.speaker ?? this.opts.defaultSpeaker ?? 3)
    );
    if (synthOpts.pitch !== undefined) {
      params.set("pitch", String(synthOpts.pitch));
    }
    if (synthOpts.intonationScale !== undefined) {
      params.set("intonationScale", String(synthOpts.intonationScale));
    }
    if (synthOpts.speed !== undefined) {
      params.set("speed", String(synthOpts.speed));
    }

    // ドキュメントで「POSTでの送信が好ましい」とされているため、
    // クエリ文字列ではなくPOSTボディで送る（keyがアクセスログ等に
    // 残りにくくなる意味もある）。
    const res = await fetch(AUDIO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const contentType = res.headers.get("content-type") ?? "";
    const bodyBuf = Buffer.from(await res.arrayBuffer());

    // 失敗時は invalidApiKey / failed / notEnoughPoints 等が
    // 音声ではない本文（JSON/テキスト）で返ってくる想定。
    // 正確なエラースキーマが未公開なため、「音声として返ってきていない」
    // ことをもって失敗とみなし、本文をそのままエラーメッセージに含める。
    if (!res.ok || !contentType.startsWith("audio/")) {
      const bodyText = bodyBuf.toString("utf-8");
      throw new TTSError(
        `音声合成に失敗しました (status=${res.status}, content-type="${contentType}"): ` +
          bodyText.slice(0, 300)
      );
    }

    return { audio: bodyBuf, contentType };
  }

  async listSpeakers(): Promise<Speaker[]> {
    const url = new URL(SPEAKERS_URL);
    url.searchParams.set("key", this.opts.apiKey);

    const res = await fetch(url);
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

/**
 * ローカルVOICEVOXエンジンの /speakers と同じ形
 * （[{ name, styles: [{ name, id }] }, ...]）を想定した緩いパーサ。
 * su-shiki側の正確なスキーマが公開されていないため、想定外の形が来ても
 * 例外にせずスキップし、パースできた分だけ返す。
 */
export function parseSpeakers(raw: unknown): Speaker[] {
  if (!Array.isArray(raw)) return [];

  const speakers: Speaker[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>).name;
    const styles = (entry as Record<string, unknown>).styles;
    if (typeof name !== "string" || !Array.isArray(styles)) continue;

    const parsedStyles: SpeakerStyle[] = [];
    for (const style of styles) {
      if (typeof style !== "object" || style === null) continue;
      const styleName = (style as Record<string, unknown>).name;
      const id = (style as Record<string, unknown>).id;
      if (typeof styleName === "string" && typeof id === "number") {
        parsedStyles.push({ name: styleName, id });
      }
    }
    if (parsedStyles.length > 0) {
      speakers.push({ name, styles: parsedStyles });
    }
  }
  return speakers;
}
