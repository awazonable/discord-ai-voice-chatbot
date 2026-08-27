import { ZundamonSession } from "../src/session/zundamonSession.js";
import type { ChatMessage, LLMClient } from "../src/llm/types.js";
import type { Utterance } from "../src/session/types.js";
import type { WakeWordConfig } from "../src/session/wakeword.js";

class ImmediateLLM implements LLMClient {
  streamStarts = 0;

  async *streamChat(_messages: ChatMessage[], _signal: AbortSignal) {
    this.streamStarts++;
    yield { text: "了解なのだ。", done: false };
  }

  async judgeContinuation() {
    return { isContinuation: false, abandonsCurrent: false, reasoning: "test" };
  }

  async summarize() {
    return { summary: "", facts: [] };
  }
}

function utt(text: string, speakerId: string): Utterance {
  return { text, speakerId, timestamp: Date.now() };
}

function waitForIdle(session: ZundamonSession): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (session.getState() === "IDLE") resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

function createSession(llm: ImmediateLLM, wakeWordConfig?: WakeWordConfig): ZundamonSession {
  return new ZundamonSession(
    llm,
    {
      onPrimaryResponsePlay: () => {},
      onSentenceReady: () => {},
      onSpeechInterrupted: () => {},
      onFinalResponse: () => {},
      onStateChange: () => {},
    },
    { wakeWordConfig },
  );
}

async function main(): Promise<void> {
  const sameSpeakerLlm = new ImmediateLLM();
  const sameSpeakerSession = createSession(sameSpeakerLlm);
  await sameSpeakerSession.onFinalUtterance(utt("あっそうだ", "speaker-a"));
  await sameSpeakerSession.onFinalUtterance(utt("淳も", "speaker-a"));
  await waitForIdle(sameSpeakerSession);

  if (sameSpeakerLlm.streamStarts !== 1) {
    throw new Error(`same-speaker cue did not recover wake word: ${sameSpeakerLlm.streamStarts}`);
  }

  await sameSpeakerSession.onFinalUtterance(utt("ああそうだ", "speaker-a"));
  await sameSpeakerSession.onFinalUtterance(utt("ずんだも", "speaker-a"));
  await waitForIdle(sameSpeakerSession);
  const streamStartsAfterSecondWake = Number(sameSpeakerLlm.streamStarts);
  if (streamStartsAfterSecondWake !== 2) {
    throw new Error(`same-speaker cue did not recover truncated wake word: ${streamStartsAfterSecondWake}`);
  }
  sameSpeakerSession.shutdown();

  const alternateConfig: WakeWordConfig = {
    canonical: ["アシスタント", "コンピューター"],
    weak: [],
    ambiguous: [],
    attentionCues: [],
    blockedCanonicalSuffixes: ["って"],
    blockedAmbiguousSuffixes: [],
  };
  const alternateLlm = new ImmediateLLM();
  const alternateSession = createSession(alternateLlm, alternateConfig);
  await alternateSession.onFinalUtterance(utt("アシスタント、こんにちは", "speaker-a"));
  await waitForIdle(alternateSession);
  await alternateSession.onFinalUtterance(utt("コンピューター、質問です", "speaker-a"));
  await waitForIdle(alternateSession);
  const alternateWakeCount = alternateLlm.streamStarts;
  if (alternateWakeCount !== 2) {
    throw new Error(`injected multiple canonical wake words failed: ${alternateWakeCount}`);
  }
  alternateSession.shutdown();

  const crossSpeakerLlm = new ImmediateLLM();
  const crossSpeakerSession = createSession(crossSpeakerLlm);
  await crossSpeakerSession.onFinalUtterance(utt("あっそうだ", "speaker-a"));
  await crossSpeakerSession.onFinalUtterance(utt("淳も来る", "speaker-b"));
  await new Promise((resolve) => setTimeout(resolve, 25));

  if (crossSpeakerLlm.streamStarts !== 0) {
    throw new Error("cue from another speaker incorrectly recovered wake word");
  }
  crossSpeakerSession.shutdown();

  console.log("PASS: session cue-assisted wake-word recovery");
}

main().catch((err) => {
  console.error("FAIL: session cue-assisted wake-word recovery", err);
  process.exitCode = 1;
});
