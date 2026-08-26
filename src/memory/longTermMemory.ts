import { randomUUID } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingClient } from "./embeddings.js";

export interface MemoryRecord {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
}

export interface SearchResult extends MemoryRecord {
  /** コサイン類似度(0〜1、高いほど近い) */
  score: number;
}

export interface LongTermMemoryOptions {
  qdrantURL: string;
  embeddings: EmbeddingClient;
  collection?: string;
  /** embeddings.model の次元数。text-embedding-3-small は1536。 */
  vectorSize?: number;
}

const DEFAULT_COLLECTION = "zundamon_memory";
const DEFAULT_VECTOR_SIZE = 1536;

/**
 * 長期記憶（階層化されたデータベース）のうち「階層」の部分は、
 * Qdrantのpayload（category/importance）によるフィルタで表現する
 * ——全文をベクトル類似度だけで探すのではなく、カテゴリや重要度で
 * 絞り込んでから検索できるようにする、という設計。
 *
 * 全ログ保存ではなく、AIが「これは覚えておく価値がある」と判断した
 * ものだけをsaveする想定（overall-design.md の記憶(DB)層の方針）。
 */
export class LongTermMemory {
  private client: QdrantClient;
  private embeddings: EmbeddingClient;
  private collection: string;
  private vectorSize: number;
  private ensured = false;

  constructor(opts: LongTermMemoryOptions) {
    this.client = new QdrantClient({ url: opts.qdrantURL });
    this.embeddings = opts.embeddings;
    this.collection = opts.collection ?? DEFAULT_COLLECTION;
    this.vectorSize = opts.vectorSize ?? DEFAULT_VECTOR_SIZE;
  }

  private async ensureCollection(): Promise<void> {
    if (this.ensured) return;
    const { exists } = await this.client.collectionExists(this.collection);
    if (!exists) {
      await this.client.createCollection(this.collection, {
        vectors: { size: this.vectorSize, distance: "Cosine" },
      });
    }
    this.ensured = true;
  }

  async save(
    text: string,
    opts: { category?: string; importance?: number } = {}
  ): Promise<MemoryRecord> {
    await this.ensureCollection();
    const vector = await this.embeddings.embed(text);

    const record: MemoryRecord = {
      id: randomUUID(),
      text,
      category: opts.category ?? "fact",
      importance: opts.importance ?? 3,
      createdAt: new Date().toISOString(),
    };

    await this.client.upsert(this.collection, {
      points: [
        {
          id: record.id,
          vector,
          payload: {
            text: record.text,
            category: record.category,
            importance: record.importance,
            createdAt: record.createdAt,
          },
        },
      ],
    });

    return record;
  }

  async search(
    query: string,
    opts: { topK?: number; category?: string; minImportance?: number } = {}
  ): Promise<SearchResult[]> {
    await this.ensureCollection();
    const vector = await this.embeddings.embed(query);

    const filter: Record<string, unknown> = {};
    const must: unknown[] = [];
    if (opts.category) {
      must.push({ key: "category", match: { value: opts.category } });
    }
    if (opts.minImportance !== undefined) {
      must.push({ key: "importance", range: { gte: opts.minImportance } });
    }
    if (must.length > 0) filter.must = must;

    const res = await this.client.query(this.collection, {
      query: vector,
      limit: opts.topK ?? 5,
      filter: must.length > 0 ? filter : undefined,
      with_payload: true,
    });

    return res.points.map((p) => {
      const payload = p.payload as Record<string, unknown>;
      return {
        id: String(p.id),
        text: String(payload.text ?? ""),
        category: String(payload.category ?? ""),
        importance: Number(payload.importance ?? 0),
        createdAt: String(payload.createdAt ?? ""),
        score: p.score ?? 0,
      };
    });
  }

  /** 疎通確認用。コレクションの点数を返す。 */
  async count(): Promise<number> {
    await this.ensureCollection();
    const res = await this.client.count(this.collection, { exact: true });
    return res.count;
  }
}
