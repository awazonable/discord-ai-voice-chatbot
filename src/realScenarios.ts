import { OpenAILLMClient } from "./llm/openaiClient.js";
import { loadConfig, describeConfig, MissingApiKeyError } from "./config.js";
import { runAllScenarios } from "./scenarioRunner.js";

/** 実API（またはOPENAI_BASE_URLが指すOpenAI互換サーバ）に対してシナリオを流す。 */
async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  console.log("実APIシナリオテストを開始します:");
  console.log(describeConfig(cfg));

  const llm = new OpenAILLMClient({
    apiKey: cfg.apiKey,
    mainModel: cfg.mainModel,
    judgeModel: cfg.judgeModel,
    baseURL: cfg.baseURL,
  });

  process.exit((await runAllScenarios(llm)) > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
