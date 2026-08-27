import { EventEmitter } from "node:events";
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { DiscordPlaybackQueue } from "../src/discord/discordPlaybackQueue.js";
import type { TTSClient } from "../src/tts/types.js";

class FakePlayer extends EventEmitter {
  state: { status: AudioPlayerStatus } = { status: AudioPlayerStatus.Idle };
  played: AudioResource[] = [];
  stopped = false;

  play(resource: AudioResource): void {
    this.played.push(resource);
    this.state = { status: AudioPlayerStatus.Playing };
  }

  stop(): boolean {
    this.stopped = true;
    this.state = { status: AudioPlayerStatus.Idle };
    return true;
  }

  finish(durationMs = 321): void {
    const resource = this.played.at(-1);
    if (resource) resource.playbackDuration = durationMs;
    const oldState = this.state;
    this.state = { status: AudioPlayerStatus.Idle };
    this.emit(AudioPlayerStatus.Idle, oldState, this.state);
  }

  fail(err: unknown): void {
    this.emit("error", err);
  }
}

class FakeConnection extends EventEmitter {
  state: { status: VoiceConnectionStatus } = { status: VoiceConnectionStatus.Ready };
  subscribed?: AudioPlayer;

  subscribe(player: AudioPlayer): void {
    this.subscribed = player;
  }

  setStatus(status: VoiceConnectionStatus): void {
    const oldState = this.state;
    this.state = { status };
    this.emit("stateChange", oldState, this.state);
  }
}

function makeTts(texts: string[], gate?: Promise<void>): TTSClient {
  return {
    async synthesize(text) {
      texts.push(text);
      if (gate) await gate;
      return { audio: Buffer.from(`RIFF-${text}`), contentType: "audio/wav" };
    },
    async listSpeakers() {
      return [];
    },
  };
}

function resourceFactory(input: NodeJS.ReadableStream): AudioResource {
  return {
    playStream: input as never,
    playbackDuration: 0,
  } as unknown as AudioResource;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function testSequentialPlaybackAndCallbacks(): Promise<void> {
  const synthesized: string[] = [];
  const starts: string[] = [];
  const dones: Array<[string, number]> = [];
  const errors: Array<[unknown, string]> = [];
  const player = new FakePlayer();
  const connection = new FakeConnection();
  const queue = new DiscordPlaybackQueue({
    tts: makeTts(synthesized),
    connection: connection as unknown as VoiceConnection,
    player: player as unknown as AudioPlayer,
    createResource: resourceFactory,
    onSentenceStart: (text) => starts.push(text),
    onSentenceDone: (text, durationMs) => dones.push([text, durationMs]),
    onError: (err, text) => errors.push([err, text]),
  });

  queue.enqueue("one");
  queue.enqueue("two");
  await tick();
  if (synthesized.join(",") !== "one" || starts.join(",") !== "one") {
    throw new Error("最初の文だけが直ちに合成・再生されるべき");
  }
  if (!queue.isBusy() || player.played.length !== 1) throw new Error("再生中状態が不正");

  player.finish();
  await tick();
  if (synthesized.join(",") !== "one,two" || player.played.length < 2) {
    throw new Error("2文目が1文目の完了後に再生されるべき");
  }
  player.finish(456);
  await tick();
  if (queue.isBusy()) throw new Error("全再生後はbusyでないべき");
  if (dones.length !== 2 || dones[0]?.[1] !== 321 || dones[1]?.[1] !== 456) {
    throw new Error("完了イベントまたは再生時間が不正");
  }
  if (errors.length !== 0) throw new Error("正常系でエラー通知されている");
  queue.close();
}

async function testTruncateKeepsCurrentSentence(): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const synthesized: string[] = [];
  const player = new FakePlayer();
  const connection = new FakeConnection();
  const queue = new DiscordPlaybackQueue({
    tts: makeTts(synthesized, gate),
    connection: connection as unknown as VoiceConnection,
    player: player as unknown as AudioPlayer,
    createResource: resourceFactory,
  });

  queue.enqueue("current");
  queue.enqueue("pending-1");
  queue.enqueue("pending-2");
  await tick();
  if (queue.truncatePending() !== 2) throw new Error("未再生文の破棄数が不正");
  release();
  await tick();
  if (synthesized.join(",") !== "current" || player.played.length !== 1) {
    throw new Error("現在文が破棄されている");
  }
  player.finish();
  await tick();
  if (queue.isBusy()) throw new Error("truncate後のキューが停止しない");
  queue.close();
}

async function testErrorsDoNotStopFollowingItems(): Promise<void> {
  const errors: string[] = [];
  let calls = 0;
  const tts: TTSClient = {
    async synthesize(text) {
      calls++;
      if (text === "bad-synthesis") throw new Error("synthesis failed");
      return { audio: Buffer.from(text), contentType: "audio/wav" };
    },
    async listSpeakers() {
      return [];
    },
  };
  const player = new FakePlayer();
  const connection = new FakeConnection();
  const queue = new DiscordPlaybackQueue({
    tts,
    connection: connection as unknown as VoiceConnection,
    player: player as unknown as AudioPlayer,
    createResource: resourceFactory,
    onError: (_err, text) => errors.push(text),
  });
  queue.enqueue("bad-synthesis");
  queue.enqueue("bad-playback");
  queue.enqueue("good");
  await tick();
  player.fail(new Error("player failed"));
  await tick();
  if (calls !== 3 || errors.join(",") !== "bad-synthesis,bad-playback") {
    throw new Error("合成・再生エラー後に後続キューが進んでいない");
  }
  player.finish();
  await tick();
  if (queue.isBusy()) throw new Error("エラー後のキューが停止している");
  queue.close();
}

async function testDestroyedConnectionIsHandled(): Promise<void> {
  const errors: string[] = [];
  const player = new FakePlayer();
  const connection = new FakeConnection();
  const queue = new DiscordPlaybackQueue({
    tts: makeTts([]),
    connection: connection as unknown as VoiceConnection,
    player: player as unknown as AudioPlayer,
    createResource: resourceFactory,
    onError: (_err, text) => errors.push(text),
  });
  queue.enqueue("current");
  queue.enqueue("pending");
  await tick();
  connection.setStatus(VoiceConnectionStatus.Destroyed);
  await tick();
  if (!errors.includes("current")) throw new Error("接続破棄時の現在文エラーがない");
  if (!errors.includes("pending")) throw new Error("接続破棄時の保留文エラーがない");
  if (queue.isBusy()) throw new Error("接続破棄後にキューがbusyのまま");
  queue.close();
}

async function testReconnectRebuildsResourceFromBuffer(): Promise<void> {
  const player = new FakePlayer();
  const connection = new FakeConnection();
  let resources = 0;
  const queue = new DiscordPlaybackQueue({
    tts: makeTts([]),
    connection: connection as unknown as VoiceConnection,
    player: player as unknown as AudioPlayer,
    createResource: (input) => {
      resources++;
      return resourceFactory(input);
    },
  });
  queue.enqueue("reconnect");
  await tick();
  connection.setStatus(VoiceConnectionStatus.Disconnected);
  player.finish();
  await tick();
  if (queue.isBusy() === false) throw new Error("切断中に再生完了扱いされている");
  connection.setStatus(VoiceConnectionStatus.Ready);
  await tick();
  if (resources !== 2 || player.played.length < 2) {
    throw new Error("再接続時にBufferからリソースを再生成していない");
  }
  player.finish();
  await tick();
  if (queue.isBusy()) throw new Error("再接続後のキューが停止している");
  queue.close();
}

async function main(): Promise<void> {
  await testSequentialPlaybackAndCallbacks();
  await testTruncateKeepsCurrentSentence();
  await testErrorsDoNotStopFollowingItems();
  await testDestroyedConnectionIsHandled();
  await testReconnectRebuildsResourceFromBuffer();
  console.log("PASS: DiscordPlaybackQueue");
}

main().catch((err) => {
  console.error("FAIL: DiscordPlaybackQueue", err);
  process.exitCode = 1;
});
