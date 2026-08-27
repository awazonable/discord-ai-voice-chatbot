import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Guild,
  type VoiceState,
} from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import { loadConfig, MissingDiscordTokenError, describeConfig } from "./config.js";
import { OpenAILLMClient } from "./llm/openaiClient.js";
import { EmbeddingClient } from "./memory/embeddings.js";
import { LongTermMemory } from "./memory/longTermMemory.js";
import { createMemoryToolConfig } from "./memory/memoryTools.js";
import { MultiSpeakerStt } from "./stt/multiSpeakerStt.js";
import { ZundamonSession } from "./session/zundamonSession.js";
import { DiscordPlaybackQueue } from "./discord/discordPlaybackQueue.js";
import { VoiceReceiverAdapter } from "./discord/voiceReceiver.js";
import { createTTSClient, describeTTSConfig } from "./tts/createTTSClient.js";
import { findZundamonSpeakerId } from "./tts/sushikiClient.js";

const STT_MODEL_SUBDIRECTORY =
  "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01";
const DEFAULT_ZUNDAMON_SPEAKER = 3;
const debugTranscriptLogging = process.argv.includes("--debug");

function getSpeakerName(
  guild: Guild,
  client: Client,
  speakerId: string
): string {
  const displayName = guild.members.cache.get(speakerId)?.displayName;
  if (displayName) return displayName;

  const username = client.users.cache.get(speakerId)?.username;
  return username || speakerId;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.discord) throw new MissingDiscordTokenError();

  const { botToken, devGuildId, devChannelIdVoice } = cfg.discord;
  if (!devGuildId || !devChannelIdVoice) {
    throw new Error(
      "DEV_GUILD_ID / DEV_CHANNEL_ID_VOICE が.envに設定されていません。"
    );
  }

  let connection: VoiceConnection | undefined;
  let playbackQueue: DiscordPlaybackQueue | undefined;
  let receiver: VoiceReceiverAdapter | undefined;
  let session: ZundamonSession | undefined;
  let voiceStateHandler: ((oldState: VoiceState, newState: VoiceState) => void) | undefined;
  let cleanupDone = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const cleanup = (reason: string): void => {
    if (cleanupDone) return;
    cleanupDone = true;
    console.log(`[終了処理] ${reason}`);

    try {
      session?.shutdown();
    } catch (error) {
      console.error("[終了処理] セッションの停止に失敗しました:", error);
    }
    try {
      receiver?.cleanup();
    } catch (error) {
      console.error("[終了処理] 音声受信の解放に失敗しました:", error);
    }
    try {
      playbackQueue?.close();
    } catch (error) {
      console.error("[終了処理] 再生キューの解放に失敗しました:", error);
    }
    try {
      if (
        connection &&
        connection.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        connection.destroy();
      }
    } catch (error) {
      console.error("[終了処理] Discord音声接続の解放に失敗しました:", error);
    }
    try {
      client.destroy();
    } catch (error) {
      console.error("[終了処理] Discordクライアントの解放に失敗しました:", error);
    }

    resolveStopped?.();
  };

  const onSignal = (signal: string): void => cleanup(signal);
  const onFatal = (error: unknown): void => {
    console.error("[致命的エラー]", error);
    process.exitCode = 1;
    cleanup("fatal error");
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("uncaughtException", onFatal);
  process.once("unhandledRejection", onFatal);

  try {
    console.log("=== ずんだもん Discord Bot ===");
    console.log(
      `[デバッグ] STT文字起こしログ: ${debugTranscriptLogging ? "有効" : "無効"}`
    );
    console.log(describeConfig(cfg));
    console.log(describeTTSConfig(cfg));

    const llm = new OpenAILLMClient({
      apiKey: cfg.apiKey,
      mainModel: cfg.mainModel,
      judgeModel: cfg.judgeModel,
      baseURL: cfg.baseURL,
    });
    const embeddings = new EmbeddingClient({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.embeddingModel,
    });
    const memory = new LongTermMemory({
      qdrantURL: cfg.qdrantURL,
      embeddings,
    });
    const memoryTools = createMemoryToolConfig(memory);
    const tts = createTTSClient(cfg);
    const zundamonSpeaker = await tts
      .listSpeakers()
      .then((speakers) => findZundamonSpeakerId(speakers) ?? DEFAULT_ZUNDAMON_SPEAKER)
      .catch((error: unknown) => {
        console.error("[TTS] ずんだもん話者一覧の取得に失敗したため既定値を使います:", error);
        return DEFAULT_ZUNDAMON_SPEAKER;
      });
    const stt = new MultiSpeakerStt({
      modelDir: `${cfg.modelsDir}/${STT_MODEL_SUBDIRECTORY}`,
      vadModelPath: `${cfg.modelsDir}/silero_vad_v5.onnx`,
    });

    console.log("[Discord] ログイン中...");
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        client.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        client.off("clientReady", onReady);
        reject(error);
      };

      client.once("clientReady", onReady);
      client.once("error", onError);
      void client.login(botToken).catch(onError);
    });
    console.log(`[Discord] ログイン成功: ${client.user?.tag ?? "unknown"}`);

    const guild = await client.guilds.fetch(devGuildId);
    const voiceChannel = await guild.channels.fetch(devChannelIdVoice);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error(
        `DEV_CHANNEL_ID_VOICE(${devChannelIdVoice})はボイスチャンネルではありません。`
      );
    }

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log(
      `[Discord] ボイスチャンネル「${voiceChannel.name}」へ接続しました。`
    );

    playbackQueue = new DiscordPlaybackQueue({
      tts,
      connection,
      speaker: zundamonSpeaker,
      onSentenceStart: (text) => console.log(`[再生開始] ${text}`),
      onSentenceDone: (text) => console.log(`[再生完了] ${text}`),
      onError: (error, text) =>
        console.error(`[音声再生エラー] ${text}`, error),
    });

    session = new ZundamonSession(
      llm,
      {
        onPrimaryResponsePlay: (phrase) => playbackQueue?.enqueue(phrase),
        onSentenceReady: (sentence) => playbackQueue?.enqueue(sentence),
        onSpeechInterrupted: (reason) => console.log(`[中断] ${reason}`),
        onFinalResponse: (text) => console.log(`[応答] ${text}`),
        onStateChange: (state) => console.log(`[状態] ${state}`),
        onAudioTruncated: (discardedSentences, discardedChars, savedMs) => {
          const discardedByQueue = playbackQueue?.truncatePending() ?? 0;
          console.log(
            `[再生破棄] session=${discardedSentences}文/${discardedChars}文字, ` +
              `queue=${discardedByQueue}文, ${savedMs}ms短縮`
          );
        },
        onError: (error, context) =>
          console.error(`[セッションエラー: ${context}]`, error),
      },
      {
        tools: memoryTools,
        wakeWordConfig: cfg.wakeWordConfig,
      }
    );

    const botUserId = client.user?.id;
    if (!botUserId) throw new Error("Discord BotのユーザーIDを取得できませんでした。");

    receiver = new VoiceReceiverAdapter({
      connection,
      stt,
      onUtterance: (utterance) => {
        if (debugTranscriptLogging && !cleanupDone) {
          console.log(
            `[STT] speaker=${JSON.stringify(utterance.speakerName)} speakerId=${JSON.stringify(utterance.speakerId)} text=${JSON.stringify(utterance.text)}`
          );
        }
        return session?.onFinalUtterance(utterance);
      },
      getSpeakerName: (speakerId) => getSpeakerName(guild, client, speakerId),
      ignoreBot: true,
      botUserId,
      onError: (error, speakerId) =>
        console.error(
          `[音声受信エラー${speakerId ? `: ${speakerId}` : ""}]`,
          error
        ),
    });

    voiceStateHandler = (oldState, newState): void => {
      if (
        oldState.channelId === devChannelIdVoice &&
        newState.channelId !== devChannelIdVoice
      ) {
        receiver?.removeSpeaker(oldState.id);
      }
    };
    client.on("voiceStateUpdate", voiceStateHandler);
    receiver.start();
    console.log("[音声受信] 待機中なのだ。Ctrl+Cで終了します。");

    await stopped;
  } catch (error) {
    cleanup("startup/runtime error");
    throw error;
  } finally {
    if (voiceStateHandler) client.off("voiceStateUpdate", voiceStateHandler);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    cleanup("finalize");
  }
}

main().catch((error) => {
  console.error("✗ Discord Botの起動に失敗しました:", error);
  process.exitCode = 1;
});
