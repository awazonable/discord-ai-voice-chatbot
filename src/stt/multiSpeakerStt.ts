import { SttEngine, type SttEngineOptions } from "./sttEngine.js";

/**
 * 複数話者が同時に話しうる環境(Discordボイスチャンネル等)向けに、
 * 話者(speakerId)ごとに独立したSttEngineを管理する。
 * stt-design.mdの「話者ごとに独立したVAD/STTパイプラインインスタンスを
 * 持たせる」方針の実装。Discord側で既にユーザー単位にストリームが
 * 分離されているため、話者間のturn-takingラベリングは不要
 * （呼び出し側がspeakerIdごとに別々にpushSamplesすればよい）。
 */
export class MultiSpeakerStt {
  private engines = new Map<string, SttEngine>();

  constructor(private engineOptions: SttEngineOptions) {}

  /** 指定話者のSttEngineを取得する。無ければ新規作成する。 */
  getEngine(speakerId: string): SttEngine {
    let engine = this.engines.get(speakerId);
    if (!engine) {
      engine = new SttEngine(this.engineOptions);
      this.engines.set(speakerId, engine);
    }
    return engine;
  }

  /**
   * 1発話セッション（Discordなら speaking start〜end の1区間）が終わる
   * たびに呼ぶ。VAD/内部バッファの状態を発話間で持ち越さないよう、
   * 次回のために新しいSttEngineに差し替える。
   *
   * 実測で、同一SttEngineを複数の発話セッションにまたがって使い回すと
   * sherpa-onnxのネイティブ層で "circular-buffer.cc: Invalid n" という
   * エラーが稀に発生することを確認した(docs/openai-test-handoff.md参照)。
   * 発話セッションごとに作り直すことでこの問題を回避する。
   */
  resetSpeaker(speakerId: string): void {
    this.engines.set(speakerId, new SttEngine(this.engineOptions));
  }

  /** 話者がボイスチャンネルを離れた等、もう使わなくなったら呼ぶ。 */
  removeSpeaker(speakerId: string): void {
    this.engines.delete(speakerId);
  }

  activeSpeakerCount(): number {
    return this.engines.size;
  }
}
