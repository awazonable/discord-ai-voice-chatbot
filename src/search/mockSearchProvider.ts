import {
  clampMaxResults,
  requireQuery,
  type SearchProvider,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from "./types.js";

export interface MockSearchProviderOptions {
  responses?: Readonly<Record<string, SearchResponse>>;
  defaultResults?: readonly SearchResult[];
  defaultAnswer?: string;
}
/** ネットワークに依存せず、同じ入力に同じ結果を返すテスト用プロバイダー。 */
export class MockSearchProvider implements SearchProvider {
  readonly requests: SearchRequest[] = [];
  private readonly responses: Readonly<Record<string, SearchResponse>>;
  private readonly defaultResults: readonly SearchResult[];
  private readonly defaultAnswer?: string;

  constructor(options: MockSearchProviderOptions = {}) {
    this.responses = options.responses ?? {};
    this.defaultResults = options.defaultResults ?? [];
    this.defaultAnswer = options.defaultAnswer;
  }

  async search(request: SearchRequest, _signal?: AbortSignal): Promise<SearchResponse> {
    const query = requireQuery(request.query);
    this.requests.push({ ...request, query });
    const configured = this.responses[query];
    const results = (configured?.results ?? this.defaultResults).slice(
      0,
      clampMaxResults(request.maxResults),
    );
    const answer = configured?.answer ?? this.defaultAnswer;
    return {
      query,
      results: results.map((result) => ({ ...result })),
      ...(answer === undefined ? {} : { answer }),
    };
  }
}
