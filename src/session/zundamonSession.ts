import type { LLMClient, ChatMessage } from "../llm/types.js";
import type { SessionEvents, SessionState, Utterance } from "./types.js";
import { detectWakeWord } from "./wakeword.js";
import { SentenceStreamBuffer } from "./sentenceBuffer.js";

const GRACE_WINDOW_MS = 2000;
const PRIMARY_RESPONSES = ["はい", "ん？", "どうしたの？"];

/**
 * 1話者分のずんだもんセッション。
 *
 * 方式: ウェイクワード検知したら「猶予ウィンドウで待つ」のではなく
 * 即座に本体LLMへ第1ラウンドとして投げる（先行投機実行）。
 * 並行して猶予ウィンドウを開き、その間に追加発話が来たら
 * 「呼びかけの続きか無関係か」をLLMに判定させ、続きなら
 * 現在のストリームに中断要求を出す。
 *
 * 中断は即座には行わず、文単位（句点等）で区切って、
 * 今組み立て中の文が完成するのを待ってから残りを破棄する
 * 「グレースフル中断」方式。これにより音声再生も文の途中で
 * 不自然に切れることがなくなる。
 */
export class ZundamonSession {
  private state: SessionState = "IDLE";
  private conversationLog: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private sentenceBuffer = new SentenceStreamBuffer();
  private accumulatedResponse = "";
  private pendingFollowup: string | null = null;

  constructor(private llm: LLMClient, private events: SessionEvents) {}

  private setState(s: SessionState) {
    this.state = s;
    this.events.onStateChange(s);
  }

  getState() {
    return this.state;
  }

  /** VADのfinal確定テキストが来るたびに呼ばれる */
  async onFinalUtterance(utt: Utterance) {
    if (this.state === "IDLE") {
      if (detectWakeWord(utt.text)) {
        await this.handleWake(utt);
      } else {
        this.conversationLog.push({ role: "user", content: utt.text });
      }
      return;
    }

    if (this.state === "AWAKENED" || this.state === "PROCESSING") {
      await this.handleFollowup(utt);
      return;
    }
  }

  private async handleWake(utt: Utterance) {
    const primaryPhrase =
      PRIMARY_RESPONSES[Math.floor(Math.random() * PRIMARY_RESPONSES.length)];
    this.events.onPrimaryResponsePlay(primaryPhrase);

    this.setState("AWAKENED");
    this.conversationLog.push({ role: "user", content: utt.text });

    this.startGraceTimer();
    this.runRound(this.conversationLog);
  }

  private startGraceTimer() {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
    }, GRACE_WINDOW_MS);
  }

  private async handleFollowup(utt: Utterance) {
    const judgeController = new AbortController();
    const { isContinuation, reasoning } = await this.llm.judgeContinuation(
      this.conversationLog,
      utt.text,
      judgeController.signal
    );

    console.log(
      `  [判定] "${utt.text}" -> continuation=${isContinuation} (${reasoning})`
    );

    if (!isContinuation) {
      return;
    }

    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    if (this.abortController) {
      // 即座にabortはしない。文単位のグレースフル中断要求を出すだけ。
      this.events.onSpeechInterrupted(
        "第2ラウンドの発話により中断要求（現在の文は言い切らせる）"
      );
      this.sentenceBuffer.requestInterrupt();
    }

    this.conversationLog.push({ role: "user", content: utt.text });
    this.pendingFollowup = utt.text;
  }

  private async runRound(messages: ChatMessage[]) {
    this.setState("PROCESSING");
    this.abortController = new AbortController();
    this.sentenceBuffer = new SentenceStreamBuffer();
    const signal = this.abortController.signal;
    this.accumulatedResponse = "";
    this.pendingFollowup = null;

    const systemPrompt: ChatMessage = {
      role: "system",
      content:
        "あなたはずんだもんです。まだユーザーの発話が続いている可能性があるため、断定的な長い応答は避け、" +
        "短く簡潔に応答してください。語尾は「〜のだ」「〜なのだ」を使ってください。",
    };

    let interruptedGracefully = false;

    try {
      for await (const token of this.llm.streamChat(
        [systemPrompt, ...messages],
        signal
      )) {
        this.accumulatedResponse += token.text;

        const completedSentences = this.sentenceBuffer.push(token.text);
        for (const sentence of completedSentences) {
          this.events.onSentenceReady(sentence);

          if (this.sentenceBuffer.isInterruptRequested()) {
            interruptedGracefully = true;
            break;
          }
        }
        if (interruptedGracefully) break;
      }

      if (!interruptedGracefully) {
        const remaining = this.sentenceBuffer.flush();
        for (const sentence of remaining) {
          this.events.onSentenceReady(sentence);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      throw err;
    }

    if (interruptedGracefully) {
      this.abortController.abort();
      const followup = this.pendingFollowup;
      if (followup) {
        this.runRound(this.conversationLog);
      }
      return;
    }

    this.conversationLog.push({
      role: "assistant",
      content: this.accumulatedResponse,
    });
    this.events.onFinalResponse(this.accumulatedResponse);
    this.setState("IDLE");
  }
}
