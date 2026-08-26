import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "./types.js";

/**
 * 実APIに何を送って何が返ってきたかを追跡できないと、preflightや
 * scenarios:real のログだけでは「応答の要約」しか残らず、後から
 * 実際のLLM出力を確認できない。呼び出しごとに1行JSONで logs/ 以下に
 * 追記する（.gitignore済み。会話内容そのものを含むため）。
 */
const LOG_PATH = "logs/llm-calls.jsonl";

export interface LLMCallLogEntry {
  timestamp: string;
  kind: "main" | "judge";
  model: string;
  messages: ChatMessage[];
  responseText?: string;
  parsed?: unknown;
  latencyMs: number;
  error?: string;
}

export function logLLMCall(entry: LLMCallLogEntry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[callLogger] ログ書き込みに失敗しました", err);
  }
}
