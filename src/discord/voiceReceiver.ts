import {
  type AudioReceiveStream,
  EndBehaviorType,
  type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import type { Utterance } from "../session/types.js";
import type { MultiSpeakerStt } from "../stt/multiSpeakerStt.js";
import type { SttEngine } from "../stt/sttEngine.js";

export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
export const STT_SAMPLE_RATE = 16_000;

const BYTES_PER_SAMPLE = 2;
const BYTES_PER_STEREO_FRAME = BYTES_PER_SAMPLE * DISCORD_CHANNELS;
const DOWN_SAMPLE_FACTOR = DISCORD_SAMPLE_RATE / STT_SAMPLE_RATE;

if (!Number.isInteger(DOWN_SAMPLE_FACTOR)) {
  throw new Error("DiscordVoiceReceiver: sample rate ratio must be an integer");
}

/**
 * Discordの48kHz stereo signed-16bit PCMを16kHz mono Float32Arrayへ変換する。
 *
 * 48kHzから16kHzへの変換は3サンプルを平均する単純なローパス兼間引きで
 * 行う。DiscordのOpusデコーダは通常フレーム境界で出力するが、ストリームの
 * チャンク境界をまたぐ残りはVoiceReceiverAdapter側で保持する。
 */
export function pcm48kStereoTo16kMono(pcm: Uint8Array): Float32Array {
  const frameCount = Math.floor(pcm.byteLength / BYTES_PER_STEREO_FRAME);
  const outputCount = Math.floor(frameCount / DOWN_SAMPLE_FACTOR);
  const mono = new Float32Array(outputCount);

  for (let outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    let sum = 0;
    const firstFrame = outputIndex * DOWN_SAMPLE_FACTOR;

    for (let frameOffset = 0; frameOffset < DOWN_SAMPLE_FACTOR; frameOffset++) {
      const frame = firstFrame + frameOffset;
      const byteOffset = frame * BYTES_PER_STEREO_FRAME;
      const left = readInt16LE(pcm, byteOffset);
      const right = readInt16LE(pcm, byteOffset + BYTES_PER_SAMPLE);
      sum += (left + right) / 2 / 32768;
    }

    mono[outputIndex] = sum / DOWN_SAMPLE_FACTOR;
  }

  return mono;
}

function readInt16LE(data: Uint8Array, offset: number): number {
  const value = data[offset] | (data[offset + 1] << 8);
  return value & 0x8000 ? value - 0x10000 : value;
}

export interface VoiceReceiverAdapterOptions {
  /** @discordjs/voiceの接続。receiver.speaking.startを購読する。 */
  connection: VoiceConnection;
  /** 話者ごとのVAD/STTを管理するMultiSpeakerStt。 */
  stt: MultiSpeakerStt;
  /** 発話確定時（pushSamplesまたはflushの結果ごと）に呼ばれる。 */
  onUtterance: (utterance: Utterance) => void | Promise<void>;
  /** 表示用話者名。未指定、または戻り値が空ならspeakerIdを使う。 */
  getSpeakerName?: (speakerId: string) => string | undefined;
  /** trueの時だけbotUserIdを受信対象から除外する。botUserId未指定なら無効。 */
  ignoreBot?: boolean;
  /** 自身のbotユーザーID。ignoreBotがfalseなら除外しない。 */
  botUserId?: string;
  /** bot以外にも受信対象外にしたいユーザーを判定する。 */
  shouldIgnoreUser?: (speakerId: string) => boolean;
  /** Discordの無音終了判定。既定値は既存疎通テストと同じ1000ms。 */
  silenceDurationMs?: number;
  /** ストリーム処理、STT、コールバックのエラー通知。 */
  onError?: (error: unknown, speakerId?: string) => void;
}

type Decoder = InstanceType<typeof prism.opus.Decoder>;

interface Subscription {
  readonly speakerId: string;
  readonly engine: SttEngine;
  readonly opusStream: AudioReceiveStream;
  readonly decoder: Decoder;
  pcmRemainder: Buffer;
  sourceEnded: boolean;
  decoderEnded: boolean;
  finished: boolean;
  sourceEndFallback?: ReturnType<typeof setImmediate>;
  onSourceEnd?: () => void;
  onSourceClose?: () => void;
  onSourceError?: (error: Error) => void;
  onDecoderData?: (chunk: Buffer) => void;
  onDecoderEnd?: () => void;
  onDecoderError?: (error: Error) => void;
}

/**
 * Discord VoiceReceiverからユーザー別音声を受け取り、MultiSpeakerSttの
 * 認識結果をsessionのUtteranceへ変換する再利用可能なアダプタ。
 *
 * デコード後の責務はこのクラスが持つ。Opus -> 48kHz stereo PCM -> 16kHz
 * mono Float32Arrayまでを行い、SttEngineには16kHzと明示して渡すため、
 * SttEngine内のリサンプラーはこの経路では動作しない。
 */
export class VoiceReceiverAdapter {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly knownSpeakerIds = new Set<string>();
  private readonly options: VoiceReceiverAdapterOptions;
  private running = false;

  private readonly onSpeakingStart = (speakerId: string): void => {
    try {
      if (!this.running || this.shouldIgnoreUser(speakerId)) return;
      if (this.subscriptions.has(speakerId)) return;

      this.subscribeSpeaker(speakerId);
    } catch (error) {
      this.reportError(error, speakerId);
    }
  };

  constructor(options: VoiceReceiverAdapterOptions) {
    this.options = options;
  }

  /** speaking.startの購読を開始する。複数回呼んでも一度だけ購読する。 */
  start(): this {
    if (this.running) return this;

    this.running = true;
    this.options.connection.receiver.speaking.on("start", this.onSpeakingStart);
    return this;
  }

  /** 購読を停止し、進行中の発話はflushしてからストリームを閉じる。 */
  stop(): this {
    if (!this.running && this.subscriptions.size === 0) return this;

    this.running = false;
    this.options.connection.receiver.speaking.off("start", this.onSpeakingStart);

    for (const subscription of [...this.subscriptions.values()]) {
      this.finishNormally(subscription);
    }

    return this;
  }

  /** stopに加えて、アダプタが見た話者のSTTエンジンも解放する。 */
  cleanup(): this {
    this.stop();

    for (const speakerId of this.knownSpeakerIds) {
      this.options.stt.removeSpeaker(speakerId);
    }
    this.knownSpeakerIds.clear();

    return this;
  }

  /** 話者退出時などに、購読と話者用STTエンジンを明示的に解放する。 */
  removeSpeaker(speakerId: string): void {
    try {
      const subscription = this.subscriptions.get(speakerId);
      if (subscription) {
        this.finishWithError(
          subscription,
          new Error(`VoiceReceiverAdapter: speaker ${speakerId} was removed`),
          false
        );
      }
    } finally {
      // 話者退出時は次回の参加を新しいSTT状態で開始できるよう、
      // 購読終了処理の成否にかかわらずエンジンをMapから外す。
      try {
        this.options.stt.removeSpeaker(speakerId);
      } finally {
        this.knownSpeakerIds.delete(speakerId);
      }
    }
  }

  /** 現在デコード中の話者IDを返す。 */
  activeSpeakerIds(): readonly string[] {
    return [...this.subscriptions.keys()];
  }

  private shouldIgnoreUser(speakerId: string): boolean {
    if (this.options.shouldIgnoreUser?.(speakerId)) return true;
    if (this.options.ignoreBot !== true) return false;
    return this.options.botUserId === speakerId;
  }

  private subscribeSpeaker(speakerId: string): void {
    let engine: SttEngine | undefined;
    let opusStream: AudioReceiveStream | undefined;
    let decoder: Decoder | undefined;

    try {
      engine = this.options.stt.getEngine(speakerId);
      opusStream = this.options.connection.receiver.subscribe(speakerId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.options.silenceDurationMs ?? 1000,
        },
      });
      decoder = new prism.opus.Decoder({
        rate: DISCORD_SAMPLE_RATE,
        channels: DISCORD_CHANNELS,
        frameSize: 960,
      });
    } catch (error) {
      if (opusStream && !opusStream.destroyed) opusStream.destroy();
      if (engine) {
        try {
          this.options.stt.resetSpeaker(speakerId);
        } catch (resetError) {
          this.reportError(resetError, speakerId);
        }
        try {
          this.options.stt.removeSpeaker(speakerId);
        } catch (removeError) {
          this.reportError(removeError, speakerId);
        }
      }
      this.reportError(error, speakerId);
      return;
    }

    // The try block above establishes all three values together. Keeping this
    // guard local avoids widening the rest of the stream-handling code.
    if (!engine || !opusStream || !decoder) return;

    const subscription: Subscription = {
      speakerId,
      engine,
      opusStream,
      decoder,
      pcmRemainder: Buffer.alloc(0),
      sourceEnded: false,
      decoderEnded: false,
      finished: false,
    };
    this.subscriptions.set(speakerId, subscription);
    this.knownSpeakerIds.add(speakerId);

    subscription.onSourceEnd = () => {
      subscription.sourceEnded = true;

      // pipe()がdecoder.end()を処理する時間を確保する。通常はdecoderの
      // endイベントが先に来るが、実装差やテスト用ストリームにも耐える。
      subscription.sourceEndFallback = setImmediate(() => {
        subscription.sourceEndFallback = undefined;
        if (!subscription.finished && !subscription.decoderEnded) {
          this.finishNormally(subscription);
        }
      });
    };
    subscription.onSourceClose = () => {
      if (!subscription.sourceEnded && !subscription.finished) {
        this.finishWithError(
          subscription,
          new Error(`VoiceReceiverAdapter: audio stream closed for ${speakerId}`)
        );
      }
    };
    subscription.onSourceError = (error) => this.finishWithError(subscription, error);
    subscription.onDecoderData = (chunk) => this.handleDecoderData(subscription, chunk);
    subscription.onDecoderEnd = () => {
      subscription.decoderEnded = true;
      this.finishNormally(subscription);
    };
    subscription.onDecoderError = (error) => this.finishWithError(subscription, error);

    opusStream.once("end", subscription.onSourceEnd);
    opusStream.once("close", subscription.onSourceClose);
    opusStream.once("error", subscription.onSourceError);
    decoder.on("data", subscription.onDecoderData);
    decoder.once("end", subscription.onDecoderEnd);
    decoder.once("error", subscription.onDecoderError);

    try {
      opusStream.pipe(decoder);
    } catch (error) {
      this.finishWithError(subscription, error);
    }
  }

  private handleDecoderData(subscription: Subscription, chunk: Buffer): void {
    if (subscription.finished) return;

    try {
      const pcm = subscription.pcmRemainder.length
        ? Buffer.concat([subscription.pcmRemainder, chunk])
        : chunk;
      const frameCount = Math.floor(pcm.length / BYTES_PER_STEREO_FRAME);
      const processFrameCount = Math.floor(frameCount / DOWN_SAMPLE_FACTOR) * DOWN_SAMPLE_FACTOR;
      const processBytes = processFrameCount * BYTES_PER_STEREO_FRAME;
      subscription.pcmRemainder = pcm.subarray(processBytes);

      if (processBytes === 0) return;

      const samples = pcm48kStereoTo16kMono(pcm.subarray(0, processBytes));
      if (samples.length === 0) return;

      // 16kHz化はこのアダプタで完了しているので、SttEngineの内部
      // LinearResamplerを起動させないために16kHzを渡す。
      const results = subscription.engine.pushSamples(samples, STT_SAMPLE_RATE);
      this.emitResults(subscription.speakerId, results);
    } catch (error) {
      this.finishWithError(subscription, error);
    }
  }

  private finishNormally(subscription: Subscription): void {
    if (subscription.finished) return;
    subscription.finished = true;
    this.subscriptions.delete(subscription.speakerId);
    this.detachSubscription(subscription);

    try {
      const results = subscription.engine.flush();
      this.emitResults(subscription.speakerId, results);
    } catch (error) {
      // flush失敗時も次回発話へ汚染を持ち越さない。
      this.resetSpeakerAfterError(subscription.speakerId, error);
    }
  }

  private finishWithError(
    subscription: Subscription,
    error: unknown,
    notify = true
  ): void {
    if (subscription.finished) return;
    subscription.finished = true;
    this.subscriptions.delete(subscription.speakerId);
    this.detachSubscription(subscription);
    this.resetSpeakerAfterError(subscription.speakerId, error, notify);
  }

  private detachSubscription(subscription: Subscription): void {
    if (subscription.sourceEndFallback) {
      clearImmediate(subscription.sourceEndFallback);
      subscription.sourceEndFallback = undefined;
    }

    if (subscription.onSourceEnd) {
      subscription.opusStream.off("end", subscription.onSourceEnd);
    }
    if (subscription.onSourceClose) {
      subscription.opusStream.off("close", subscription.onSourceClose);
    }
    if (subscription.onSourceError) {
      subscription.opusStream.off("error", subscription.onSourceError);
    }
    if (subscription.onDecoderData) {
      subscription.decoder.off("data", subscription.onDecoderData);
    }
    if (subscription.onDecoderEnd) {
      subscription.decoder.off("end", subscription.onDecoderEnd);
    }
    if (subscription.onDecoderError) {
      subscription.decoder.off("error", subscription.onDecoderError);
    }

    subscription.opusStream.unpipe(subscription.decoder);
    if (!subscription.opusStream.destroyed) subscription.opusStream.destroy();
    if (!subscription.decoder.destroyed) subscription.decoder.destroy();
  }

  private resetSpeakerAfterError(
    speakerId: string,
    error: unknown,
    notify = true
  ): void {
    let resetError: unknown;
    try {
      this.options.stt.resetSpeaker(speakerId);
    } catch (caught) {
      resetError = caught;
    }

    if (notify) this.reportError(error, speakerId);
    if (resetError !== undefined) this.reportError(resetError, speakerId);
  }

  private emitResults(
    speakerId: string,
    results: ReturnType<SttEngine["pushSamples"]>
  ): void {
    for (const result of results) {
      const utterance: Utterance = {
        text: result.text,
        speakerId,
        speakerName: this.options.getSpeakerName?.(speakerId) ?? speakerId,
        timestamp: Date.now(),
      };

      try {
        const pending = this.options.onUtterance(utterance);
        if (pending && typeof pending.then === "function") {
          void pending.catch((error: unknown) => this.reportError(error, speakerId));
        }
      } catch (error) {
        this.reportError(error, speakerId);
      }
    }
  }

  private reportError(error: unknown, speakerId?: string): void {
    try {
      this.options.onError?.(error, speakerId);
    } catch {
      // エラー通知側の例外で音声ストリームを壊さない。
    }
  }
}

/** 本体側で意味が伝わりやすい別名。実体はVoiceReceiverAdapterと同じ。 */
export const DiscordVoiceReceiver = VoiceReceiverAdapter;
