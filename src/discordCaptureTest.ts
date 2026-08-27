// @ts-nocheck prism-mediaのストリーム型が実行時のBuffer型と一致しないため
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from "@discordjs/voice";
import prism from "prism-media";
import { loadConfig, MissingDiscordTokenError } from "./config.js";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const CAPTURE_TIMEOUT_MS = 15_000;

async function main() {
  const cfg = loadConfig();
  if (!cfg.discord) throw new MissingDiscordTokenError();
  const { botToken, devGuildId, devChannelIdVoice } = cfg.discord;
  if (!devGuildId || !devChannelIdVoice) {
    throw new Error("DEV_GUILD_ID / DEV_CHANNEL_ID_VOICE が.envに設定されていません。");
  }

  console.log("=== Discord音声キャプチャ診断（音声は保存しません） ===");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  let connection;

  try {
    console.log("[1] Discordにログイン中...");
    await new Promise<void>((resolve, reject) => {
      client.once("clientReady", () => resolve());
      client.once("error", reject);
      client.login(botToken).catch(reject);
    });
    console.log("  ✓ ログイン成功");

    const guild = await client.guilds.fetch(devGuildId);
    const voiceChannel = await guild.channels.fetch(devChannelIdVoice);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("DEV_CHANNEL_ID_VOICEはボイスチャンネルではありません。");
    }

    console.log(`[2] ボイスチャンネル「${voiceChannel.name}」に参加中...`);
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log("  ✓ 接続確立。最初に話した人の1発話を最大15秒待機します。");

    // Diagnostics only: aggregate statistics incrementally; no audio is saved.
    let byteCount = 0;
    let sampleCount = 0;
    let peak = 0;
    let sumSquares = 0;
    const pendingUsers = new Set<string>();
    let selectedUserId: string | undefined;
    let decoder;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        connection.receiver.speaking.off("start", onSpeakingStart);
        if (error) reject(error);
        else resolve();
      };

      const timeout = setTimeout(() => {
        console.log("  ⏱ 発話を検知せず待機時間が終了しました。");
        finish();
      }, CAPTURE_TIMEOUT_MS);

      const onSpeakingStart = async (userId: string) => {
        if (settled || selectedUserId || pendingUsers.has(userId)) return;
        pendingUsers.add(userId);

        try {
          const user = await client.users.fetch(userId);
          if (user.bot || settled || selectedUserId) return;

          selectedUserId = userId;
          console.log("  🎤 発話開始を検知しました。1発話をキャプチャ中...");
          const opusStream = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
          });
          decoder = new prism.opus.Decoder({
            rate: SAMPLE_RATE,
            channels: CHANNELS,
            frameSize: 960,
          });

          opusStream.on("error", (error) => finish(error));
          decoder.on("data", (chunk: Buffer) => {
            byteCount += chunk.length;
            const chunkSampleCount = Math.floor(chunk.length / 2);
            sampleCount += chunkSampleCount;

            for (let i = 0; i < chunkSampleCount; i++) {
              const sample = chunk.readInt16LE(i * 2);
              const normalized = sample / 32768;
              peak = Math.max(peak, Math.abs(normalized));
              sumSquares += normalized * normalized;
            }
          });
          decoder.once("end", () => finish());
          decoder.once("error", (error) => finish(error));
          opusStream.pipe(decoder);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        } finally {
          pendingUsers.delete(userId);
        }
      };

      connection.receiver.speaking.on("start", onSpeakingStart);
    });

    const durationMs = (sampleCount / CHANNELS / SAMPLE_RATE) * 1000;
    const rms = sampleCount === 0 ? 0 : Math.sqrt(sumSquares / sampleCount);
    console.log("  ✓ 診断完了（音声データは破棄され、保存されていません）");
    console.log(
      `  bytes=${byteCount} durationMs=${durationMs.toFixed(1)} ` +
        `peak=${peak.toFixed(4)} rms=${rms.toFixed(4)}`
    );
  } finally {
    if (connection) connection.destroy();
    client.destroy();
    console.log("=== テスト終了 ===");
  }
}

main().catch((error) => {
  console.error("✗ キャプチャ診断に失敗しました:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
