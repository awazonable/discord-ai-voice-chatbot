import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses.js";
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_SEARCH_ANSWER_LENGTH,
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

export interface OpenAIWebSearchProviderOptions {
  model: string;
  /** Responses APIを差し替えられるため、実APIなしで試験できる。 */
  client?: Pick<OpenAI, "responses">;
  apiKey?: string;
  maxToolCalls?: number;
  maxResults?: number;
}

// v7.5.0の生成型ではmax_tool_callsの記述がResponses APIの別名前空間に
// ありますが、responses.createの引数型には露出していません。実際のAPI
// パラメーターを失わず、SDK更新時にも基底型との互換性を保つ局所型です。
type WebSearchCreateParams = ResponseCreateParamsNonStreaming & {
  max_tool_calls?: number | null;
};

/** OpenAI Responses APIのweb_searchを共通SearchProviderへ適合させる。 */
export class OpenAIWebSearchProvider implements SearchProvider {
  private readonly client: Pick<OpenAI, "responses">;
  private readonly model: string;
  private readonly maxToolCalls: number;
  private readonly maxResults: number;

  constructor(options: OpenAIWebSearchProviderOptions) {
    if (!options.model.trim()) throw new SearchProviderError("OpenAI検索のmodelが空です");
    if (!options.client && !options.apiKey) {
      throw new SearchProviderError("OpenAI検索にはclientまたはapiKeyが必要です");
    }
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.model = options.model;
    this.maxToolCalls = positiveInteger(options.maxToolCalls ?? 2, "maxToolCalls");
    this.maxResults = clampMaxResults(options.maxResults);
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const query = requireQuery(request.query);
    const params: WebSearchCreateParams = {
      model: this.model,
      input: query,
      tools: [{ type: "web_search", search_context_size: "low" }],
      include: ["web_search_call.action.sources"],
      max_tool_calls: this.maxToolCalls,
      store: false,
      stream: false,
    };

    let response: Response;
    try {
      response = await this.client.responses.create(
        params as ResponseCreateParamsNonStreaming,
        { signal },
      );
    } catch (error) {
      if (signal?.aborted) throw new SearchProviderError("OpenAI検索が中断されました", error);
      throw new SearchProviderError("OpenAI Web Search呼び出しに失敗しました", error);
    }

    return normalizeOpenAIResponse(query, response, clampMaxResults(request.maxResults, this.maxResults));
  }
}

function normalizeOpenAIResponse(query: string, response: Response, maxResults: number): SearchResponse {
  const byUrl = new Map<string, SearchResult>();
  for (const item of response.output) {
    if (item.type === "web_search_call" && item.action.type === "search") {
      for (const source of item.action.sources ?? []) addSource(byUrl, source.url, "");
    }
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations) {
        if (annotation.type === "url_citation") {
          addSource(byUrl, annotation.url, annotation.title);
        }
      }
    }
  }

  return {
    query,
    answer: truncateSearchText(response.output_text ?? "", MAX_SEARCH_ANSWER_LENGTH),
    results: [...byUrl.values()].slice(0, maxResults),
  };
}

function addSource(byUrl: Map<string, SearchResult>, rawUrl: string, rawTitle: string): void {
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (url.length > MAX_SEARCH_URL_LENGTH || !isHttpUrl(url)) return;
  const existing = byUrl.get(url);
  if (existing) {
    if (rawTitle && existing.title === url) {
      existing.title = truncateSearchText(rawTitle, 500);
    }
    return;
  }
  byUrl.set(url, {
    title: truncateSearchText(rawTitle || url, 500),
    url,
    snippet: "",
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SearchProviderError(`${name}は正の整数にしてください`);
  }
  return value;
}
