import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { TTSClient } from "../tts/types.js";

export interface DiscordPlaybackQueueOptions {
  tts: TTSClient;
  connection: VoiceConnection;
  speaker?: number;
  /** テスト用。未指定時は @discordjs/voice の AudioPlayer を生成する。 */
  player?: AudioPlayer;
  /** テスト用。未指定時は WAV を FFmpeg 経由で Discord 用リソースに変換する。 */
  createResource?: (input: Readable) => AudioResource;
  /** 再生時間計測用。通常は Date.now を使う。 */
  now?: () => number;
  onSentenceStart?: (text: string) => void;
  onSentenceDone?: (text: string, measuredMs: number) => void;
  onError?: (err: unknown, text: string) => void;
}

interface CurrentSentence {
  text: string;
  audio: Buffer;
  resource: AudioResource;
  startedAt: number;
  waitingForConnection: boolean;
  settled: boolean;
  resolve: (result: PlaybackResult) => void;
  reject: (err: unknown) => void;
}

type PlaybackResult = { durationMs: number } | { closed: true };

/**
 * TTS の WAV 音声を Discord の VoiceConnection へ順番に送るキュー。
 *
 * 現在文は `truncatePending()` では触らず、まだ合成・再生を開始していない
 * 文だけを破棄する。音声は一時ファイルに書かず、Buffer から Readable を作る。
 */
export class DiscordPlaybackQueue {
  private pending: string[] = [];
  private current: CurrentSentence | null = null;
  private processing = false;
  private closed = false;
  private connectionDestroyed = false;
  private readonly player: AudioPlayer;
  private readonly createResource: (input: Readable) => AudioResource;
  private readonly now: () => number;
  private readonly onPlayerIdle: (
    oldState: unknown,
    newState: unknown
  ) => void;
  private readonly onPlayerError: (err: unknown) => void;
  private readonly onConnectionStateChange: (
    oldState: unknown,
    newState: unknown
  ) => void;
  private readonly onConnectionError: (err: unknown) => void;

  constructor(private readonly opts: DiscordPlaybackQueueOptions) {
    this.player =
      opts.player ??
      createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      });
    this.createResource =
      opts.createResource ??
      ((input) =>
        createAudioResource(input, { inputType: StreamType.Arbitrary }));
    this.now = opts.now ?? Date.now;

    opts.connection.subscribe(this.player);

    this.onPlayerIdle = (_oldState, newState) => {
      if (
        this.closed ||
        !this.current ||
        this.stateStatus(newState) !== AudioPlayerStatus.Idle
      ) {
        return;
      }

      if (this.connectionStatus() !== undefined && !this.isConnectionReady()) {
        if (this.connectionDestroyed) {
          this.settleCurrentError(new Error("VoiceConnection が破棄されました"));
        } else {
          this.current.waitingForConnection = true;
        }
        return;
      }

      this.settleCurrentDone();
    };
    this.onPlayerError = (err) => {
      if (this.closed) return;
      if (this.current) {
        this.settleCurrentError(err);
      } else {
        this.notifyError(err, "");
      }
    };
    this.onConnectionStateChange = (_oldState, newState) => {
      const status = this.stateStatus(newState);
      if (status === VoiceConnectionStatus.Destroyed) {
        this.connectionDestroyed = true;
        if (this.current) {
          this.settleCurrentError(new Error("VoiceConnection が破棄されました"));
        }
        this.player.stop(true);
        void this.drain();
        return;
      }

      if (status !== VoiceConnectionStatus.Ready && this.current) {
        this.current.waitingForConnection = true;
      }

      if (status === VoiceConnectionStatus.Ready && this.current?.waitingForConnection) {
        this.current.waitingForConnection = false;
        if (this.player.state.status === AudioPlayerStatus.Idle) {
          this.current.resource = this.createResource(Readable.from([this.current.audio]));
          this.playCurrentResource(this.current);
        }
      }
    };
    this.onConnectionError = (err) => {
      if (this.closed) return;
      if (this.current) {
        this.settleCurrentError(err);
      } else {
        this.notifyError(err, "");
      }
    };

    this.player.on(AudioPlayerStatus.Idle, this.onPlayerIdle);
    this.player.on("error", this.onPlayerError);
    opts.connection.on("stateChange", this.onConnectionStateChange);
    opts.connection.on("error", this.onConnectionError);

    this.connectionDestroyed = this.connectionStatus() === VoiceConnectionStatus.Destroyed;
  }

  enqueue(text: string): void {
    if (this.closed) return;
    this.pending.push(text);
    void this.drain();
  }

  /** まだ現在文になっていない文だけを破棄し、破棄数を返す。 */
  truncatePending(): number {
    const discarded = this.pending.length;
    this.pending = [];
    return discarded;
  }

  isBusy(): boolean {
    return !this.closed && (this.processing || this.pending.length > 0);
  }

  /** キューを閉じる。現在文の完了通知は発火せず、再生も停止する。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    if (this.current && !this.current.settled) {
      this.current.settled = true;
      this.current.resolve({ closed: true });
      this.current = null;
    }
    this.player.off(AudioPlayerStatus.Idle, this.onPlayerIdle);
    this.player.off("error", this.onPlayerError);
    this.opts.connection.off("stateChange", this.onConnectionStateChange);
    this.opts.connection.off("error", this.onConnectionError);
    this.player.stop(true);
  }

  private async drain(): Promise<void> {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      while (!this.closed && this.pending.length > 0) {
        const text = this.pending.shift();
        if (text === undefined) break;

        this.notifyStart(text);
        try {
          if (this.connectionDestroyed) {
            throw new Error("VoiceConnection が破棄されています");
          }

          const { audio } = await this.opts.tts.synthesize(text, {
            speaker: this.opts.speaker,
          });
          if (this.closed) break;

          const resource = this.createResource(Readable.from([audio]));
          const result = await this.play(text, audio, resource);
          if (!("closed" in result)) {
            this.notifyDone(text, result.durationMs);
          }
        } catch (err) {
          if (!this.closed) this.notifyError(err, text);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private play(text: string, audio: Buffer, resource: AudioResource): Promise<PlaybackResult> {
    return new Promise<PlaybackResult>((resolve, reject) => {
      const current: CurrentSentence = {
        text,
        audio,
        resource,
        startedAt: this.now(),
        waitingForConnection: !this.isConnectionReady(),
        settled: false,
        resolve,
        reject,
      };
      this.current = current;
      this.playCurrentResource(current);
    });
  }

  private playCurrentResource(current: CurrentSentence): void {
    if (this.closed || this.current !== current || current.settled) return;
    try {
      current.startedAt = this.now();
      this.player.play(current.resource);
    } catch (err) {
      this.settleCurrentError(err);
    }
  }

  private settleCurrentDone(): void {
    const current = this.current;
    if (!current || current.settled) return;
    current.settled = true;
    this.current = null;
    const resourceDuration = current.resource.playbackDuration;
    current.resolve({
      durationMs:
        resourceDuration > 0 ? resourceDuration : Math.max(0, this.now() - current.startedAt),
    });
  }

  private settleCurrentError(err: unknown): void {
    const current = this.current;
    if (!current || current.settled) return;
    current.settled = true;
    this.current = null;
    current.reject(err);
  }

  private connectionStatus(): VoiceConnectionStatus | undefined {
    return this.stateStatus(this.opts.connection.state) as VoiceConnectionStatus | undefined;
  }

  private stateStatus(state: unknown): string | undefined {
    if (!state || typeof state !== "object" || !("status" in state)) return undefined;
    return (state as { status?: string }).status;
  }

  private isConnectionReady(): boolean {
    const status = this.connectionStatus();
    return status === undefined || status === VoiceConnectionStatus.Ready;
  }

  private notifyStart(text: string): void {
    try {
      this.opts.onSentenceStart?.(text);
    } catch (err) {
      this.notifyError(err, text);
    }
  }

  private notifyDone(text: string, durationMs: number): void {
    try {
      this.opts.onSentenceDone?.(text, durationMs);
    } catch (err) {
      this.notifyError(err, text);
    }
  }

  private notifyError(err: unknown, text: string): void {
    try {
      this.opts.onError?.(err, text);
    } catch {
      // 利用側の通知コールバック例外で、後続の再生を止めない。
    }
  }
}
