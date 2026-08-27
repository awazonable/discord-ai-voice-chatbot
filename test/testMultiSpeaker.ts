import { ZundamonSession } from "../src/session/zundamonSession.js";
import type { LLMClient, ChatMessage, StreamToken } from "../src/llm/types.js";
import type { Utterance } from "../src/session/types.js";

/**
 * 複数話者対応の検証: 異なる話者(speakerId/speakerName)からの発話が、
 * 会話ログのメッセージに正しく name として反映されるかを確認する。
 * 実APIは使わず、messagesをそのまま記録するスタブLLMで検証する。
 */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

class CapturingLLMClient implements LLMClient {
  capturedMessages: ChatMessage[][] = [];

  async *streamChat(messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<StreamToken> {
    this.capturedMessages.push(messages);
    await sleep(10);
    yield { text: "了解なのだ", done: false };
    yield { text: "", done: true };
  }

  async judgeContinuation() {
    return { isContinuation: false, abandonsCurrent: false, reasoning: "test" };
  }

  async summarize() {
    return { summary: "", facts: [] };
  }
}

function utt(text: string, speakerId: string, speakerName: string): Utterance {
  return { text, speakerId, speakerName, timestamp: Date.now() };
}

function waitForIdle(session: ZundamonSession): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (session.getState() === "IDLE") resolve();
      else setTimeout(check, 20);
    };
    check();
  });
}

async function main() {
  console.log("=== 複数話者対応テスト ===\n");

  const llm = new CapturingLLMClient();
  const session = new ZundamonSession(llm, {
    onPrimaryResponsePlay: () => {},
    onSentenceReady: () => {},
    onSpeechInterrupted: () => {},
    onFinalResponse: () => {},
    onStateChange: () => {},
  });

  console.log("[1] 話者Aが起動発話");
  await session.onFinalUtterance(utt("ずんだもん、こんにちは", "user-a-111", "Alice"));
  await waitForIdle(session);

  console.log("[2] 話者Bが起動発話（同じセッション、別話者）");
  await session.onFinalUtterance(utt("ずんだもん、はじめまして", "user-b-222", "Bob"));
  await waitForIdle(session);

  const lastMessages = llm.capturedMessages.at(-1)!;
  console.log("\n最後のラウンドで送られたメッセージ:");
  for (const m of lastMessages) {
    console.log(`  role=${m.role} name=${m.name ?? "(なし)"} content="${m.content}"`);
  }

  const aliceMsg = lastMessages.find((m) => m.content === "ずんだもん、こんにちは");
  const bobMsg = lastMessages.find((m) => m.content === "ずんだもん、はじめまして");

  console.log("\n[3] 日本語表示名の話者が起動発話（異なるDiscord ID）");
  await session.onFinalUtterance(utt("ずんだもん、元気？", "123456789012345678", "太郎"));
  await waitForIdle(session);
  await session.onFinalUtterance(utt("ずんだもん、質問です", "987654321098765432", "花子"));
  await waitForIdle(session);

  const japaneseMessages = llm.capturedMessages.at(-1)!;
  const taroMsg = japaneseMessages.find((m) => m.content === "ずんだもん、元気？");
  const hanakoMsg = japaneseMessages.find((m) => m.content === "ずんだもん、質問です");
  const validMessageName = (name: string | undefined) =>
    !!name && name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name);

  const checks = [
    ["Aliceの発言にname=Aliceが付いている", aliceMsg?.name === "Alice"],
    ["Bobの発言にname=Bobが付いている", bobMsg?.name === "Bob"],
    ["両者のnameが異なる(話者を区別できている)", aliceMsg?.name !== bobMsg?.name],
    ["日本語表示名のnameが有効な形式", validMessageName(taroMsg?.name) && validMessageName(hanakoMsg?.name)],
    ["異なるDiscord IDから異なるnameが生成される", taroMsg?.name !== hanakoMsg?.name],
  ] as const;

  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) allOk = false;
  }

  console.log(`\n${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
