/** 検索バックエンドに依存しない検索要求。 */
export interface SearchRequest {
  query: string;
  language?: string;
  timeRange?: "day" | "week" | "month" | "year";
  maxResults?: number;
}

/** 検索結果1件。urlはHTTP(S)に限定する。 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}

/** 検索結果を各プロバイダー共通の形式へ正規化した値。 */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answer?: string;
}

/** SearXNG/OpenAIなどの実装を差し替えるための最小契約。 */
export interface SearchProvider {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
}

export const DEFAULT_SEARCH_MAX_RESULTS = 5;
export const ABSOLUTE_SEARCH_MAX_RESULTS = 10;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_SEARCH_QUERY_LENGTH = 2000;
export const MAX_SEARCH_TEXT_LENGTH = 2000;
export const MAX_SEARCH_ANSWER_LENGTH = 4000;
export const MAX_SEARCH_URL_LENGTH = 2048;

export function clampMaxResults(value: number | undefined, fallback = DEFAULT_SEARCH_MAX_RESULTS): number {
  const candidate = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(ABSOLUTE_SEARCH_MAX_RESULTS, Math.max(1, candidate));
}

export function requireQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw new Error("検索クエリが空です");
  if (normalized.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`検索クエリが長すぎます（最大${MAX_SEARCH_QUERY_LENGTH}文字）`);
  }
  return normalized;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function truncateSearchText(value: string, maxLength = MAX_SEARCH_TEXT_LENGTH): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
