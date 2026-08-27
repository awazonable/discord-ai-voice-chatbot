import "dotenv/config";
import { SearXNGSearchProvider } from "./search/searxngSearchProvider.js";

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim() || "OpenAI";
  const provider = new SearXNGSearchProvider({
    baseURL: process.env.SEARXNG_URL || "http://127.0.0.1:8080",
    timeoutMs: 10_000,
    maxResults: 3,
  });
  const response = await provider.search({
    query,
    language: "ja",
    maxResults: 3,
  });

  console.log(`query: ${response.query}`);
  console.log(`results: ${response.results.length}`);
  for (const result of response.results) {
    console.log(`- ${result.title}`);
    console.log(`  ${result.url}`);
  }
  if (response.results.length === 0) {
    throw new Error("SearXNGから検索結果を取得できませんでした。");
  }
}

main().catch((error) => {
  console.error("SearXNGスモークテスト失敗:", error);
  process.exitCode = 1;
});
