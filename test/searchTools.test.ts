import assert from "node:assert/strict";
import { loadSearchConfig } from "../src/config.js";
import { mergeToolConfigs } from "../src/llm/toolConfig.js";
import type { ToolConfig } from "../src/llm/types.js";
import { MockSearchProvider } from "../src/search/mockSearchProvider.js";
import {
  createSearchProvider,
  createWebSearchToolConfig,
} from "../src/webSearchTools.js";

function tool(name: string, result: string, instruction?: string): ToolConfig {
  return {
    definitions: [
      {
        name,
        description: `${name} test tool`,
        parameters: { type: "object", properties: {} },
      },
    ],
    instructions: instruction ? [instruction] : undefined,
    onCall: async () => result,
  };
}

async function testMergeToolConfigs(): Promise<void> {
  const merged = mergeToolConfigs(
    tool("first", "one", "first instruction"),
    tool("second", "two", "second instruction"),
  );
  assert.ok(merged);
  assert.deepEqual(
    merged.definitions.map((definition) => definition.name),
    ["first", "second"],
  );
  assert.deepEqual(merged.instructions, ["first instruction", "second instruction"]);
  assert.equal(await merged.onCall("first", "{}"), "one");
  assert.equal(await merged.onCall("second", "{}"), "two");
  await assert.rejects(() => merged.onCall("missing", "{}"), /未知のツール/);
  assert.throws(
    () => mergeToolConfigs(tool("duplicate", "one"), tool("duplicate", "two")),
    /重複/,
  );
  assert.equal(mergeToolConfigs(undefined), undefined);
}

function testSearchConfig(): void {
  assert.deepEqual(loadSearchConfig({ WEB_SEARCH_BACKEND: "disabled" }), {
    backend: "disabled",
  });
  assert.deepEqual(loadSearchConfig({}), {
    backend: "searxng",
    baseURL: "http://127.0.0.1:8080",
    timeoutMs: 7_000,
    maxResults: 5,
  });
  assert.deepEqual(
    loadSearchConfig(
      {
        WEB_SEARCH_BACKEND: "openai",
        WEB_SEARCH_MODEL: "search-model",
        WEB_SEARCH_TIMEOUT_MS: "1234",
        WEB_SEARCH_MAX_RESULTS: "3",
      },
      "main-model",
    ),
    {
      backend: "openai",
      model: "search-model",
      timeoutMs: 1234,
      maxResults: 3,
    },
  );
  const defaultOpenAIModel = loadSearchConfig(
    { WEB_SEARCH_BACKEND: "openai" },
    "main-model",
  );
  assert.equal(defaultOpenAIModel.backend, "openai");
  if (defaultOpenAIModel.backend === "openai") {
    assert.equal(defaultOpenAIModel.model, "main-model");
  }
  assert.throws(
    () => loadSearchConfig({ WEB_SEARCH_BACKEND: "unknown" }),
    /searxng \/ openai \/ disabled/,
  );
  assert.throws(
    () =>
      loadSearchConfig({
        WEB_SEARCH_BACKEND: "searxng",
        SEARXNG_URL: "file:///tmp/search",
      }),
    /HTTP\(S\)/,
  );
  assert.throws(
    () =>
      loadSearchConfig({
        WEB_SEARCH_BACKEND: "searxng",
        WEB_SEARCH_MAX_RESULTS: "11",
      }),
    /WEB_SEARCH_MAX_RESULTS/,
  );
}

async function testWebSearchTool(): Promise<void> {
  const provider = new MockSearchProvider({
    defaultAnswer: "要約",
    defaultResults: [
      { title: "Result", url: "https://example.com", snippet: "Snippet" },
    ],
  });
  const config = createWebSearchToolConfig(provider);
  assert.equal(config.definitions[0]?.name, "web_search");
  assert.match(config.instructions?.join(" ") ?? "", /外部入力/);

  const raw = await config.onCall(
    "web_search",
    JSON.stringify({ query: "  現在の情報  ", language: "ja", time_range: "week" }),
  );
  assert.deepEqual(provider.requests, [
    { query: "現在の情報", language: "ja", timeRange: "week" },
  ]);
  assert.deepEqual(JSON.parse(raw), {
    query: "現在の情報",
    answer: "要約",
    results: [
      { title: "Result", url: "https://example.com", snippet: "Snippet" },
    ],
  });

  await assert.rejects(() => config.onCall("unknown", "{}"), /未知のツール/);
  await assert.rejects(() => config.onCall("web_search", "not-json"), /有効なJSON/);
  await assert.rejects(
    () => config.onCall("web_search", JSON.stringify({ query: "query", time_range: "all" })),
    /time_range/,
  );
  assert.equal(
    createSearchProvider(
      { backend: "disabled" },
      { apiKey: "unused" },
    ),
    undefined,
  );

  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const signalAwareTool = createWebSearchToolConfig({
    async search(request, signal) {
      receivedSignal = signal;
      return { query: request.query, results: [] };
    },
  });
  await signalAwareTool.onCall(
    "web_search",
    JSON.stringify({ query: "signal" }),
    controller.signal,
  );
  assert.equal(receivedSignal, controller.signal);
}

async function main(): Promise<void> {
  await testMergeToolConfigs();
  testSearchConfig();
  await testWebSearchTool();
  console.log("PASS: web search tool composition and config");
}

main().catch((error) => {
  console.error("FAIL: web search tool composition and config", error);
  process.exitCode = 1;
});
