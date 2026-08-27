import OpenAI from "openai";

export interface EmbeddingClientOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

const DEFAULT_MODEL = "text-embedding-3-small";

/**
 * 長期記憶をベクトル化するための薄いラッパー。
 * text-embedding-3-small は1536次元・安価（本体LLMとは別課金）。
 */
export class EmbeddingClient {
  private client: OpenAI;
  readonly model: string;

  constructor(opts: EmbeddingClientOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    const vector = res.data[0]?.embedding;
    if (!vector) throw new Error("embeddingの取得に失敗しました（空のレスポンス）");
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return res.data.map((d) => d.embedding);
  }
}
