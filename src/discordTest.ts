import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} from "@discordjs/voice";
import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig, MissingDiscordTokenError } from "./config.js";
import { createTTSClient } from "./tts/createTTSClient.js";
import { findZundamonSpeakerId } from "./tts/sushikiClient.js";

/**
 * Discord Bot接続 + ボイスチャンネル参加 + 実音声再生の疎通テスト。
 * DEV_CHANNEL_ID_VOICE に参加してVOICEVOX音声を再生し、
 * DEV_CHANNEL_ID_TEXT に完了報告を送る。
 */
async function main() {
  const cfg = loadConfig();
  if (!cfg.discord) throw new MissingDiscordTokenError();
  const { botToken, devGuildId, devChannelIdText, devChannelIdVoice } = cfg.discord;
  if (!devGuildId || !devChannelIdVoice) {
    throw new Error("DEV_GUILD_ID / DEV_CHANNEL_ID_VOICE が.envに設定されていません。");
  }

  console.log("=== Discord疎通テスト ===\n");

  console.log("[1] 音声を合成中...");
  const tts = createTTSClient(cfg);
  const speakers = await tts.listSpeakers();
  const speakerId = findZundamonSpeakerId(speakers) ?? 3;
  const { audio } = await tts.synthesize("こんにちはなのだ！接続テストなのだ！", {
    speaker: speakerId,
  });
  mkdirSync("output", { recursive: true });
  const audioPath = "output/discord-test.wav";
  writeFileSync(audioPath, audio);
  console.log(`  ✓ 合成完了 (${audio.length} bytes)\n`);

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

  console.log("[3] ギルド・ボイスチャンネルを取得中...");
  const guild = await client.guilds.fetch(devGuildId);
  const voiceChannel = await guild.channels.fetch(devChannelIdVoice);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    throw new Error(`DEV_CHANNEL_ID_VOICE(${devChannelIdVoice})はボイスチャンネルではありません。`);
  }
  console.log(`  ✓ ギルド: ${guild.name} / ボイスチャンネル: ${voiceChannel.name}\n`);

  console.log("[4] ボイスチャンネルに参加中...");
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  console.log("  ✓ 接続確立\n");

  console.log("[5] 音声を再生中...");
  const player = createAudioPlayer();
  const resource = createAudioResource(audioPath);
  connection.subscribe(player);
  player.play(resource);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("再生タイムアウト")), 15_000);
    player.once(AudioPlayerStatus.Idle, () => {
      clearTimeout(timeout);
      resolve();
    });
    player.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  console.log("  ✓ 再生完了\n");

  if (devChannelIdText) {
    console.log("[6] テキストチャンネルに報告を送信中...");
    const textChannel = await client.channels.fetch(devChannelIdText);
    if (textChannel?.isSendable()) {
      await textChannel.send("✓ Discord接続テスト成功なのだ！音声も再生できたのだ！");
      console.log("  ✓ 送信完了\n");
    }
  }

  connection.destroy();
  client.destroy();
  console.log("=== 疎通テスト成功 ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ Discord疎通テストに失敗しました:", err);
  process.exit(1);
});
