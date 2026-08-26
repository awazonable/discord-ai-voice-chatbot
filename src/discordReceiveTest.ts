// @ts-nocheck sherpa-onnx-nodeの型無し呼び出しを含むため
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from "@discordjs/voice";
import prism from "prism-media";
import { loadConfig, MissingDiscordTokenError } from "./config.js";
import { MultiSpeakerStt } from "./stt/multiSpeakerStt.js";

/**
 * Discordボイスチャンネルからの音声受信 + STT疎通テスト。
 * ボイスチャンネルに参加し、話しているユーザーのOpusストリームを購読して
 * PCMにデコード、話者ごとのSttEngine(MultiSpeakerStt)に流し込んで
 * 認識結果を表示する。複数人が同時に話しても話者ごとに独立して認識される。
 *
 * 実際に人間がボイスチャンネルで話す必要があるため、自動化できない
 * （TTS再生のような自己完結テストにはできない）。
 */

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;

/** Discordの48kHzステレオ16bit PCM(Buffer) を 16kHzモノラルFloat32Arrayへ */
function toMonoFloat32(pcmBuffer: Buffer): Float32Array {
  const sampleCount = pcmBuffer.length / 2 / DISCORD_CHANNELS;
  const mono = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const l = pcmBuffer.readInt16LE(i * 4);
    const r = pcmBuffer.readInt16LE(i * 4 + 2);
    mono[i] = (l + r) / 2 / 32768;
  }
  return mono;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.discord) throw new MissingDiscordTokenError();
  const { botToken, devGuildId, devChannelIdVoice } = cfg.discord;
  if (!devGuildId || !devChannelIdVoice) {
    throw new Error("DEV_GUILD_ID / DEV_CHANNEL_ID_VOICE が.envに設定されていません。");
  }

  console.log("=== Discord音声受信+STT疎通テスト ===\n");

  console.log("[1] STTエンジン初期化中...");
  const modelDir = `${cfg.modelsDir}/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01`;
  const vadModelPath = `${cfg.modelsDir}/silero_vad_v5.onnx`;
  const stt = new MultiSpeakerStt({ modelDir, vadModelPath });
  console.log("  ✓ 初期化完了\n");

  console.log("[2] Discordにログイン中...");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  await new Promise<void>((resolve, reject) => {
    client.once("clientReady", () => resolve());
    client.once("error", reject);
    client.login(botToken).catch(reject);
  });
  console.log(`  ✓ ログイン成功: ${client.user?.tag}\n`);

  const guild = await client.guilds.fetch(devGuildId);
  const voiceChannel = await guild.channels.fetch(devChannelIdVoice);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    throw new Error("DEV_CHANNEL_ID_VOICEはボイスチャンネルではありません。");
  }

  console.log("[3] ボイスチャンネルに参加中...");
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // 受信するためミュートしない
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  console.log(`  ✓ 接続確立。ボイスチャンネル「${voiceChannel.name}」で話しかけてください。\n`);
  console.log("  (60秒間受信します。無音1秒で1発話として確定します)\n");

  // Discordの speaking "start" は、同一の発話中でも短い間が空くたびに
  // 何度も発火する(実測で1発話につき10回以上)。そのたびにsubscribe()する
  // と同じ音声ストリームに対して複数のOpusデコーダが同時に読み書きする
  // ことになり、opusscriptのWASMデコーダが破損する
  // ("RuntimeError: memory access out of bounds"を実際に確認)。
  // ユーザーごとに購読中フラグを持ち、二重購読を防ぐ。
  const activeSubscriptions = new Set<string>();

  connection.receiver.speaking.on("start", (userId) => {
    if (activeSubscriptions.has(userId)) return;
    activeSubscriptions.add(userId);

    const user = client.users.cache.get(userId);
    console.log(`  🎤 発話開始検知: ${user?.tag ?? userId}`);

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: 960,
    });

    const engine = stt.getEngine(userId);
    opusStream.pipe(decoder);
    decoder.on("data", (pcmChunk: Buffer) => {
      const mono = toMonoFloat32(pcmChunk);
      const results = engine.pushSamples(mono, DISCORD_SAMPLE_RATE);
      for (const r of results) {
        console.log(`  >>> [${user?.tag ?? userId}] "${r.text}" (${r.durationMs.toFixed(0)}ms)`);
      }
    });
    decoder.on("end", () => {
      activeSubscriptions.delete(userId);
      const results = engine.flush();
      for (const r of results) {
        console.log(`  >>> [${user?.tag ?? userId}] "${r.text}" (flush)`);
      }
      // 発話セッションごとにエンジンを作り直す(VAD/バッファの状態を
      // 次回に持ち越さない。circular-bufferのネイティブエラー対策)。
      stt.resetSpeaker(userId);
      console.log(`  🔇 発話終了: ${user?.tag ?? userId}`);
    });
    decoder.on("error", (err) => {
      activeSubscriptions.delete(userId);
      console.error("  [デコードエラー]", err);
    });
  });

  await new Promise((r) => setTimeout(r, 60_000));

  connection.destroy();
  client.destroy();
  console.log("\n=== テスト終了 ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ テストに失敗しました:", err);
  process.exit(1);
});
