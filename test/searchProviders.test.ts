import assert from "node:assert/strict";
import { SearXNGSearchProvider } from "../src/search/searxngSearchProvider.js";
import { MockSearchProvider } from "../src/search/mockSearchProvider.js";
import { OpenAIWebSearchProvider } from "../src/search/openaiWebSearchProvider.js";
import type { SearchResponse } from "../src/search/types.js";
import type OpenAI from "openai";

async function testSearXNGRequestAndNormalization(): Promise<void> {
  let requested!: URL;
  const provider = new SearXNGSearchProvider({
    baseURL: "http://localhost:8080/",
    maxResults: 2,
    fetch: async (input, init) => {
      requested = new URL(String(input));
      assert.equal(init?.method, "GET");
      return new Response(
        JSON.stringify({
          results: [
            { title: "  Result 1  ", url: "https://example.com/1", content: "snippet", engine: "google" },
            { title: "Result 2", url: "http://example.com/2", content: "second" },
            { title: "ignored", url: "ftp://example.com/3", content: "not HTTP(S)" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await provider.search({
    query: "ずんだもん 最新ニュース",
    language: "ja",
    timeRange: "day",
    maxResults: 99,
  });
  assert.equal(requested.pathname, "/search");
  assert.equal(requested.searchParams.get("q"), "ずんだもん 最新ニュース");
  assert.equal(requested.searchParams.get("format"), "json");
  assert.equal(requested.searchParams.get("safesearch"), "2");
  assert.equal(requested.searchParams.get("language"), "ja");
  assert.equal(requested.searchParams.get("time_range"), "day");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]?.title, "Result 1");
  assert.equal(result.results[0]?.source, "google");
}

async function testSearXNGLimitsAndErrors(): Promise<void> {
  assert.throws(
    () => new SearXNGSearchProvider({ baseURL: "file:///tmp/searxng" }),
    /HTTP\(S\) URL/,
  );

  const oversized = new SearXNGSearchProvider({
    baseURL: "http://localhost:8080",
    maxResponseBytes: 4,
    fetch: async () => new Response('{"results":[]}'),
  });
  await assert.rejects(() => oversized.search({ query: "query" }), /大きすぎます/);

  const badJson = new SearXNGSearchProvider({
    baseURL: "http://localhost:8080",
    fetch: async () => new Response("not json"),
  });
  await assert.rejects(() => badJson.search({ query: "query" }), /有効なJSON/);
}

async function testMockIsDeterministic(): Promise<void> {
  const expected: SearchResponse = {
    query: "ignored",
    answer: "固定回答",
    results: [{ title: "固定結果", url: "https://example.com", snippet: "固定" }],
  };
  const provider = new MockSearchProvider({ responses: { "同じ質問": expected } });
  const first = await provider.search({ query: "同じ質問" });
  const second = await provider.search({ query: "同じ質問" });
  assert.deepEqual(first, { ...expected, query: "同じ質問" });
  assert.deepEqual(second, first);
  assert.equal(provider.requests.length, 2);
}

async function testOpenAIResponsesWebSearch(): Promise<void> {
  let received: unknown;
  const fakeClient = {
    responses: {
      create: async (params: unknown, options?: { signal?: AbortSignal }) => {
        received = params;
        assert.ok(options?.signal instanceof AbortSignal);
        return {
          output_text: "検索結果の要約",
          output: [
            {
              type: "web_search_call",
              action: { type: "search", sources: [{ type: "url", url: "https://example.com/source" }] },
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "検索結果の要約",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.com/source",
                      title: "Example",
                      start_index: 0,
                      end_index: 1,
                    },
                  ],
                },
              ],
            },
          ],
        };
      },
    },
  } as unknown as Pick<OpenAI, "responses">;

  const provider = new OpenAIWebSearchProvider({
    model: "gpt-5.6-luna",
    client: fakeClient,
    maxToolCalls: 1,
  });
  const result = await provider.search({ query: "OpenAI web search" }, new AbortController().signal);
  const params = received as Record<string, unknown>;
  assert.equal(params.model, "gpt-5.6-luna");
  assert.equal(params.input, "OpenAI web search");
  assert.deepEqual(params.tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.deepEqual(params.include, ["web_search_call.action.sources"]);
  assert.equal(params.max_tool_calls, 1);
  assert.equal(params.store, false);
  assert.equal(result.answer, "検索結果の要約");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.title, "Example");
}

async function main(): Promise<void> {
  await testSearXNGRequestAndNormalization();
  await testSearXNGLimitsAndErrors();
  await testMockIsDeterministic();
  await testOpenAIResponsesWebSearch();
  console.log("PASS: search providers");
}

main().catch((error) => {
  console.error("FAIL: search providers", error);
  process.exitCode = 1;
});
