import { loadConfig } from "./config.js";
import { EmbeddingClient } from "./memory/embeddings.js";
import { LongTermMemory } from "./memory/longTermMemory.js";

/**
 * 長期記憶(Qdrant)の単発疎通テスト。
 * いくつか記憶を保存し、意味的に近い/遠いクエリで検索して
 * ベクトル検索がちゃんと効いているかを確認する。
 */
async function main() {
  const cfg = loadConfig();

  console.log("=== 長期記憶(Qdrant) 疎通テスト ===");
  console.log(`  qdrant  : ${cfg.qdrantURL}`);
  console.log(`  embedding model: ${cfg.embeddingModel}`);
  console.log();

  const embeddings = new EmbeddingClient({
    apiKey: cfg.apiKey,
    model: cfg.embeddingModel,
  });
  const memory = new LongTermMemory({
    qdrantURL: cfg.qdrantURL,
    embeddings,
    collection: "zundamon_memory_test",
  });

  console.log("[1] 記憶を保存中...");
  const facts = [
    { text: "ユーザーの好きな食べ物はずんだ餅である", category: "preference", importance: 4 },
    { text: "ユーザーは毎週火曜日にテニスをしている", category: "fact", importance: 3 },
    { text: "ユーザーの誕生日は8月26日である", category: "fact", importance: 5 },
    { text: "ユーザーは辛い食べ物が苦手である", category: "preference", importance: 3 },
  ];
  for (const f of facts) {
    const rec = await memory.save(f.text, f);
    console.log(`  ✓ 保存: "${rec.text}" (category=${rec.category}, importance=${rec.importance})`);
  }
  console.log(`  合計件数: ${await memory.count()}`);
  console.log();

  console.log("[2] 検索テスト...");
  const queries = ["好きな食べ物は？", "運動の習慣について教えて", "誕生日はいつ？"];
  for (const q of queries) {
    const results = await memory.search(q, { topK: 2 });
    console.log(`  クエリ: "${q}"`);
    for (const r of results) {
      console.log(`    - [score=${r.score.toFixed(3)}] ${r.text}`);
    }
  }
  console.log();

  console.log("[3] カテゴリ絞り込み検索テスト (category=preference)...");
  const filtered = await memory.search("何が好き？", { topK: 5, category: "preference" });
  for (const r of filtered) {
    console.log(`    - [score=${r.score.toFixed(3)}] ${r.text}`);
  }

  console.log("\n=== 疎通テスト成功 ===");
}

main().catch((err) => {
  console.error("✗ 長期記憶テストに失敗しました:", err);
  process.exit(1);
});
