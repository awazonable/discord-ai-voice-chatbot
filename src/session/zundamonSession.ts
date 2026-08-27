import type { LLMClient, ChatMessage, ToolConfig } from "../llm/types.js";
import { isAbortError } from "../llm/errors.js";
import type { SessionEvents, SessionState, Utterance } from "./types.js";
import {
  DEFAULT_WAKE_WORD_CONFIG,
  detectWakeWord,
  stripWakeWord,
  type WakeWordConfig,
} from "./wakeword.js";
import { SentenceStreamBuffer } from "./sentenceBuffer.js";
import { AudioClock } from "./audioClock.js";
import { ShortTermMemory } from "../memory/shortTermMemory.js";

const GRACE_WINDOW_MS = 2000;
const PRIMARY_RESPONSES = ["はい", "ん？", "どうしたの？"];
/** 会話ログがこの件数を超えたら、古い分を短期記憶(要約)に圧縮する */
const COMPACT_THRESHOLD_MESSAGES = 10;
/** 圧縮後も生ログのまま残す直近のメッセージ数 */
const KEEP_RECENT_MESSAGES = 6;

/**
 * OpenAI APIのmessage.nameは英数字・アンダースコア・ハイフンのみ許容。
 * Discordの表示名は絵文字や記号を含みうるため、そのままでは使えない。
 */
function sanitizeSpeakerName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function speakerIdFallback(speakerId: string): string {
  const safeId = speakerId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safeId) return `speaker_${safeId}`.slice(0, 64);

  // Keep arbitrary test/non-Discord IDs distinguishable without putting
  // unsupported characters into message.name.
  let hash = 2166136261;
  for (let i = 0; i < speakerId.length; i++) {
    hash ^= speakerId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `speaker_${(hash >>> 0).toString(16)}`.slice(0, 64);
}

export interface ZundamonSessionOptions {
  /** 長期記憶(save_memory/search_memory)等、LLMに渡すツール定義。 */
  tools?: ToolConfig;
  /** 省略時は現在のずんだもん互換設定を使う。 */
  wakeWordConfig?: WakeWordConfig;
}

function isToolConfig(
  value: ToolConfig | ZundamonSessionOptions | undefined,
): value is ToolConfig {
  return !!value && "definitions" in value && "onCall" in value;
}

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
  private previousFinalizedTextBySpeaker = new Map<string, string>();
  private wakeWordConfig: WakeWordConfig;
  private speakerNames = new Map<string, string>();
  private usedSpeakerNames = new Set<string>();
  private abortController: AbortController | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private sentenceBuffer = new SentenceStreamBuffer();
  /**
   * テキスト生成の速さと音声再生の速さのズレを追跡する仮クロック
   * （VOICEVOX未接続のため文字数から概算）。セッション全体で1つ持ち続け、
   * ラウンドをまたいでも「前の音声が再生し終わってから次が始まる」を
   * 自然に表現する。
   */
  private audioClock = new AudioClock();
  private accumulatedResponse = "";
  private pendingFollowup: string | null = null;
  private closed = false;
  private judgeControllers = new Set<AbortController>();
  private compactionController: AbortController | null = null;
  /** 短期記憶: 直近の会話の要約+重要な事実。毎回inputに差し込む。 */
  private shortTermMemory = new ShortTermMemory();
  private compacting = false;

  constructor(
    private llm: LLMClient,
    private events: SessionEvents,
    /** 既存のToolConfig形式、またはツールとウェイクワードの設定。 */
    toolsOrOptions?: ToolConfig | ZundamonSessionOptions,
  ) {
    if (isToolConfig(toolsOrOptions)) {
      this.tools = toolsOrOptions;
      this.wakeWordConfig = DEFAULT_WAKE_WORD_CONFIG;
    } else {
      this.tools = toolsOrOptions?.tools;
      this.wakeWordConfig = toolsOrOptions?.wakeWordConfig ?? DEFAULT_WAKE_WORD_CONFIG;
    }
  }

  private tools?: ToolConfig;

  private setState(s: SessionState) {
    this.state = s;
    this.events.onStateChange(s);
  }

  getState() {
    return this.state;
  }

  /** セッションを再開不能な状態にして、進行中の処理を中断する。 */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    for (const controller of this.judgeControllers) controller.abort();
    this.judgeControllers.clear();
    this.compactionController?.abort();
    this.compactionController = null;
    this.pendingFollowup = null;
    this.sentenceBuffer = new SentenceStreamBuffer();
    this.setState("IDLE");
  }

  /**
   * 発話を会話ログ用のメッセージに変換する。話者名(name)を載せることで、
   * 複数話者が同じ会話に参加していてもLLMが「誰の発言か」を区別できる
   * ようにする（roleは全員"user"になるため、それだけでは区別が付かない）。
   */
  private toUserMessage(utt: Utterance): ChatMessage {
    let name = this.speakerNames.get(utt.speakerId);
    if (!name) {
      const readableName = sanitizeSpeakerName(utt.speakerName ?? "");
      name = readableName && !this.usedSpeakerNames.has(readableName)
        ? readableName
        : speakerIdFallback(utt.speakerId);

      let suffix = 2;
      const baseName = name;
      while (this.usedSpeakerNames.has(name)) {
        const suffixText = `_${suffix++}`;
        name = `${baseName.slice(0, 64 - suffixText.length)}${suffixText}`;
      }

      this.speakerNames.set(utt.speakerId, name);
      this.usedSpeakerNames.add(name);
    }

    return {
      role: "user",
      content: utt.text,
      name,
    };
  }

  private reportError(err: unknown, context: string) {
    if (this.events.onError) {
      this.events.onError(err, context);
    } else {
      console.error(`[${context}]`, err);
    }
  }

  /** VADのfinal確定テキストが来るたびに呼ばれる */
  async onFinalUtterance(utt: Utterance) {
    if (this.closed) return;

    // 検知より先に更新しないことが重要。現在の発話から見た「直前」を
    // 同期的に確定してから、処理がawaitで並行しても話者ごとの順序を崩さない。
    const previousUtterance = this.previousFinalizedTextBySpeaker.get(utt.speakerId);
    this.previousFinalizedTextBySpeaker.set(utt.speakerId, utt.text);

    if (this.state === "IDLE") {
      if (detectWakeWord(utt.text, {
        previousUtterance,
        config: this.wakeWordConfig,
      })) {
        await this.handleWake(utt);
      } else {
        this.conversationLog.push(this.toUserMessage(utt));
      }
      return;
    }

    if (this.state === "AWAKENED" || this.state === "PROCESSING") {
      await this.handleFollowup(utt, previousUtterance);
      return;
    }
  }

  private async handleWake(utt: Utterance) {
    if (this.closed) return;

    const primaryPhrase =
      PRIMARY_RESPONSES[Math.floor(Math.random() * PRIMARY_RESPONSES.length)]!;
    this.events.onPrimaryResponsePlay(primaryPhrase);

    this.setState("AWAKENED");
    this.conversationLog.push(this.toUserMessage(utt));

    this.startGraceTimer();
    this.startRound();
  }

  /**
   * ラウンドはバックグラウンドで走らせる（await しない）。
   * 生成中も次の発話を受け付けるためだが、そのままだと例外が
   * unhandled rejection になるので必ずここで捕まえる。
   */
  private startRound() {
    if (this.closed) return;

    void this.runRound(this.conversationLog).catch((err) => {
      if (isAbortError(err)) return;
      if (this.closed) return;
      this.reportError(err, "runRound");
      this.abortController = null;
      this.setState("IDLE");
    });
  }

  private startGraceTimer() {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
    }, GRACE_WINDOW_MS);
  }

  private async handleFollowup(utt: Utterance, previousUtterance?: string) {
    if (this.closed) return;

    // 判定コスト最適化: ウェイクワードだけ(本題が空)の発話は、LLM判定に
    // かけるまでもなく「継続なし」で確定できる。呼びかけ語の言い直しや
    // マイク越しの誤検知など、実運用で頻出しうるケース。判定LLMの
    // 往復(実測で数百ms〜数秒)をまるごと省略できる。
    if (
      stripWakeWord(utt.text, {
        previousUtterance,
        config: this.wakeWordConfig,
      }).trim().length === 0
    ) {
      if (this.events.onJudge) {
        this.events.onJudge(false, "呼びかけ語のみのためローカル判定(LLM未呼び出し)", utt.text);
      }
      return;
    }

    const judgeController = new AbortController();
    this.judgeControllers.add(judgeController);

    let isContinuation: boolean;
    let abandonsCurrent: boolean;
    let reasoning: string;
    try {
      ({ isContinuation, abandonsCurrent, reasoning } =
        await this.llm.judgeContinuation(
          this.conversationLog,
          utt.text,
          judgeController.signal
        ));
    } catch (err) {
      this.judgeControllers.delete(judgeController);
      if (isAbortError(err)) return;
      // 判定が落ちても進行中の応答は壊さない。継続なしとして扱う。
      this.reportError(err, "judgeContinuation");
      return;
    }
    this.judgeControllers.delete(judgeController);
    if (this.closed) return;

    if (this.events.onJudge) {
      this.events.onJudge(isContinuation, reasoning, utt.text);
    } else {
      console.log(
        `  [判定] "${utt.text}" -> continuation=${isContinuation} (${reasoning})`
      );
    }

    if (!isContinuation) {
      return;
    }

    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    this.conversationLog.push(this.toUserMessage(utt));

    // 実APIでは judgeContinuation に数百ms〜数秒かかる。その間に
    // ラウンドが完走していると abortController は既に null になっており、
    // ここで中断要求を出しても誰も見ないまま発話が握り潰される。
    // ラウンドが生きているかどうかで扱いを分ける。
    if (this.abortController) {
      // 即座にabortはしない。文単位のグレースフル中断要求を出すだけ。
      this.events.onSpeechInterrupted(
        "第2ラウンドの発話により中断要求（現在の文は言い切らせる）"
      );
      this.sentenceBuffer.requestInterrupt();
      this.pendingFollowup = utt.text;
    } else {
      // 判定中にラウンドが終わっていた場合は、中断ではなく新しい
      // ラウンドとして即座に走らせる。
      //
      // ただし「テキストが終わっている」ことは「音声が再生し終わっている」
      // ことを意味しない（テキスト生成の方が音声再生よりずっと速いため）。
      // abandonsCurrent（＝今の話を打ち切りたい意図）なら、テキスト側で
      // 中断するものが無くても、音声キューにまだ残っている未再生分は
      // ここで破棄する。「ついでに」のような追加要求(abandonsCurrent=false)
      // では、今流れている音声はそのまま聞かせたいので破棄しない。
      if (abandonsCurrent) {
        const { discarded, discardedChars, savedMs } =
          this.audioClock.truncateToCurrent();
        if (discarded > 0) {
          this.events.onAudioTruncated?.(discarded, discardedChars, savedMs);
        }
      }
      this.startRound();
    }
  }

  private async runRound(messages: ChatMessage[]) {
    if (this.closed) return;
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
        "短く簡潔に応答してください。語尾は「〜のだ」「〜なのだ」を使ってください。" +
        (this.tools?.instructions?.length
          ? ` ${this.tools.instructions.join(" ")}`
          : ""),
    };

    // トークン構成: システムプロンプト / 短期記憶(要約+重要な事実) /
    // 直近の会話ログ(末尾が現在の問いかけ)。長期記憶はここには含めず、
    // 必要ならLLMがsearch_memoryツールを呼んで自分で取りに行く。
    const shortTermBlock = this.shortTermMemory.render();
    const contextMessages: ChatMessage[] = shortTermBlock
      ? [{ role: "system", content: shortTermBlock }]
      : [];

    let interruptedGracefully = false;

    try {
      for await (const token of this.llm.streamChat(
        [systemPrompt, ...contextMessages, ...messages],
        signal,
        this.tools
      )) {
        if (this.closed) return;
        this.accumulatedResponse += token.text;

        const completedSentences = this.sentenceBuffer.push(token.text);
        for (const sentence of completedSentences) {
          if (this.closed) return;
          this.audioClock.enqueue(sentence);
          this.events.onSentenceReady(sentence);

          if (this.sentenceBuffer.isInterruptRequested()) {
            interruptedGracefully = true;
            break;
          }
        }
        if (interruptedGracefully) break;
      }

      if (!interruptedGracefully) {
        if (this.closed) return;
        const remaining = this.sentenceBuffer.flush();
        for (const sentence of remaining) {
          if (this.closed) return;
          this.audioClock.enqueue(sentence);
          this.events.onSentenceReady(sentence);
        }
      }
    } catch (err) {
      // モックは DOMException、OpenAI SDK は APIUserAbortError を投げる。
      if (isAbortError(err)) {
        this.abortController = null;
        return;
      }
      throw err;
    }

    if (interruptedGracefully) {
      this.abortController.abort();
      this.abortController = null;

      // テキスト生成は音声再生よりずっと速いため、中断要求が届いた時点で
      // 既に何文も先まで音声キューに積まれてしまっている。再生がまだ
      // 始まっていない分はここで一緒に破棄する（生成を止めるだけでは
      // キューに積まれた分がそのまま流れ切ってしまうため）。
      const { discarded, discardedChars, savedMs } =
        this.audioClock.truncateToCurrent();
      if (discarded > 0) {
        this.events.onAudioTruncated?.(discarded, discardedChars, savedMs);
      }

      const followup = this.pendingFollowup;
      if (this.closed) return;
      if (followup) {
        this.startRound();
      } else {
        this.setState("IDLE");
      }
      return;
    }

    this.abortController = null;
    if (this.closed) return;
    this.conversationLog.push({
      role: "assistant",
      content: this.accumulatedResponse,
    });
    this.events.onFinalResponse(this.accumulatedResponse);
    this.setState("IDLE");

    if (this.conversationLog.length > COMPACT_THRESHOLD_MESSAGES) {
      void this.compactMemory();
    }
  }

  /**
   * 会話ログの古い部分を短期記憶(要約+重要な事実)に圧縮する。
   * バックグラウンドで実行し、応答のIDLE復帰は待たせない。
   * 実行中に新しいラウンドが会話ログへ追記されても、要約対象は
   * 呼び出し時点でスライスした「先頭側の一部」に固定してあるため、
   * 末尾への追記とは競合しない（同時に2つ走らないようcompactingで防ぐ）。
   */
  private async compactMemory() {
    if (this.compacting || this.closed) return;
    this.compacting = true;
    try {
      const cutoff = this.conversationLog.length - KEEP_RECENT_MESSAGES;
      const toSummarize = this.conversationLog.slice(0, cutoff);
      if (toSummarize.length === 0) return;

      const ctrl = new AbortController();
      this.compactionController = ctrl;
      const { summary, facts } = await this.llm.summarize(
        toSummarize,
        this.shortTermMemory.getSummary(),
        ctrl.signal
      );
      this.shortTermMemory.setSummary(summary);
      for (const f of facts) this.shortTermMemory.addFact(f);

      // 先頭側 toSummarize.length 件を取り除く。末尾への追記はここまでの
      // 間に起きていても影響しない（前方だけを削るため）。
      this.conversationLog = this.conversationLog.slice(toSummarize.length);

      if (this.closed) return;
      this.events.onMemoryCompacted?.(summary, facts);
    } catch (err) {
      // 圧縮に失敗しても会話ログはそのまま残るので、次ラウンド以降も
      // 生ログとして機能し続ける（劣化はするが会話は継続できる）。
      if (this.closed) return;
      this.reportError(err, "compactMemory");
    } finally {
      this.compactionController = null;
      this.compacting = false;
    }
  }
}
