import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_SEARCH_URL_LENGTH,
  clampMaxResults,
  isHttpUrl,
  requireQuery,
  truncateSearchText,
  type SearchProvider,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from "./types.js";
import { SearchProviderError } from "./errors.js";

export interface SearXNGSearchProviderOptions {
  baseURL: string;
  timeoutMs?: number;
  maxResults?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

interface SearXNGResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
  publishedDate?: unknown;
}

interface SearXNGPayload {
  results?: unknown;
}

/**
 * SearXNGのJSON検索APIだけを利用するプロバイダー。
 * 検索結果URLを開いたり、任意ページの本文を取得したりはしない。
 */
export class SearXNGSearchProvider implements SearchProvider {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SearXNGSearchProviderOptions) {
    this.endpoint = parseEndpoint(options.baseURL);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 7000, "timeoutMs");
    this.maxResults = clampMaxResults(options.maxResults);
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const query = requireQuery(request.query);
    const url = new URL(this.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/search`;
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    // SafeSearchはモデルから変更できない固定値にする。
    url.searchParams.set("safesearch", "2");
    if (request.language) url.searchParams.set("language", request.language);
    if (request.timeRange) url.searchParams.set("time_range", request.timeRange);

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new SearchProviderError(`SearXNG検索がタイムアウトしました（${this.timeoutMs}ms）`, error);
        if (signal?.aborted) throw new SearchProviderError("SearXNG検索が中断されました", error);
        throw new SearchProviderError("SearXNGへの接続に失敗しました", error);
      }

      if (!response.ok) {
        throw new SearchProviderError(`SearXNGがHTTP ${response.status}を返しました`);
      }

      let body: ArrayBuffer;
      try {
        body = await response.arrayBuffer();
      } catch (error) {
        if (timedOut) {
          throw new SearchProviderError(`SearXNG検索がタイムアウトしました（${this.timeoutMs}ms）`, error);
        }
        if (signal?.aborted) throw new SearchProviderError("SearXNG検索が中断されました", error);
        throw new SearchProviderError("SearXNGのレスポンス読み込みに失敗しました", error);
      }
      if (body.byteLength > this.maxResponseBytes) {
        throw new SearchProviderError(
          `SearXNGのレスポンスが大きすぎます（最大${this.maxResponseBytes}バイト）`,
        );
      }

      let payload: SearXNGPayload;
      try {
        payload = JSON.parse(new TextDecoder().decode(body)) as SearXNGPayload;
      } catch (error) {
        throw new SearchProviderError("SearXNGのレスポンスが有効なJSONではありません", error);
      }

      if (!Array.isArray(payload.results)) {
        throw new SearchProviderError("SearXNGのレスポンスにresults配列がありません");
      }

      const results = payload.results
        .map((item): SearchResult | null => normalizeResult(item))
        .filter((item): item is SearchResult => item !== null)
        .slice(0, clampMaxResults(request.maxResults, this.maxResults));
      return { query, results };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function parseEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SearchProviderError("SearXNGのbaseURLがURLではありません", error);
  }
  if (!isHttpUrl(url.toString())) {
    throw new SearchProviderError("SearXNGのbaseURLはHTTP(S) URLにしてください");
  }
  return url;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SearchProviderError(`${name}は正の整数にしてください`);
  }
  return value;
}

function normalizeResult(item: unknown): SearchResult | null {
  if (!item || typeof item !== "object") return null;
  const result = item as SearXNGResult;
  const title = typeof result.title === "string" ? truncateSearchText(result.title) : "";
  const url = typeof result.url === "string" ? result.url.trim() : "";
  if (!title || url.length > MAX_SEARCH_URL_LENGTH || !isHttpUrl(url)) return null;
  return {
    title,
    url,
    snippet: typeof result.content === "string" ? truncateSearchText(result.content) : "",
    ...(typeof result.engine === "string" && result.engine.trim()
      ? { source: truncateSearchText(result.engine, 200) }
      : {}),
    ...(typeof result.publishedDate === "string" && result.publishedDate.trim()
      ? { publishedAt: truncateSearchText(result.publishedDate, 100) }
      : {}),
  };
}
