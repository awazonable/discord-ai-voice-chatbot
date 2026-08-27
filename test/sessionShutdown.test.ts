import { ZundamonSession } from "../src/session/zundamonSession.js";
import type { LLMClient } from "../src/llm/types.js";
import type { Utterance } from "../src/session/types.js";

function utterance(text: string): Utterance {
  return { text, speakerId: "非Discord:test/ID", timestamp: Date.now() };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function main(): Promise<void> {
  const streamStarted = deferred();
  let streamAborted = false;
  let finalResponses = 0;
  let sentences = 0;

  const llm: LLMClient = {
    async *streamChat(_messages, signal) {
      streamStarted.resolve();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          streamAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
    async judgeContinuation() {
      return { isContinuation: false, abandonsCurrent: false, reasoning: "" };
    },
    async summarize() {
      return { summary: "", facts: [] };
    },
  };

  const session = new ZundamonSession(llm, {
    onPrimaryResponsePlay: () => {},
    onSentenceReady: () => { sentences++; },
    onSpeechInterrupted: () => {},
    onFinalResponse: () => { finalResponses++; },
    onStateChange: () => {},
  });

  await session.onFinalUtterance(utterance("ずんだもん、話して"));
  await streamStarted.promise;
  session.shutdown();
  await session.onFinalUtterance(utterance("ずんだもん、shutdown後の発話"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  if (!streamAborted) throw new Error("active stream was not aborted");
  if (session.getState() !== "IDLE") throw new Error("shutdown did not return to IDLE");
  if (finalResponses !== 0 || sentences !== 0) {
    throw new Error("shutdown emitted a response after closing");
  }

  console.log("PASS: ZundamonSession shutdown");
}

main().catch((err) => {
  console.error("FAIL: ZundamonSession shutdown", err);
  process.exitCode = 1;
});
