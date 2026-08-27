import { SttEngine, type SttEngineOptions } from "./sttEngine.js";

/**
 * 複数話者が同時に話しうる環境(Discordボイスチャンネル等)向けに、
 * 話者(speakerId)ごとに独立したSttEngineを管理する。
 * stt-design.mdの「話者ごとに独立したVAD/STTパイプラインインスタンスを
 * 持たせる」方針の実装。Discord側で既にユーザー単位にストリームが
 * 分離されているため、話者間のturn-takingラベリングは不要
 * （呼び出し側がspeakerIdごとに別々にpushSamplesすればよい）。
 *
 * OfflineRecognizer(160MB超のONNXモデル)はステートレスなので、
 * ここで1つだけ構築して全話者のSttEngineで共有する。話者ごとに
 * 持つのはVad+CircularBuffer(数MB、軽量)だけにすることで、
 * 話者数が増えてもメモリ使用量が線形に膨らまないようにしている
 * （Opusによるレビューで指摘された設計。詳細はCLAUDE.md参照）。
 */
export class MultiSpeakerStt {
  private engines = new Map<string, SttEngine>();
  private sharedRecognizer: SttEngineOptions["recognizer"];

  constructor(private engineOptions: SttEngineOptions) {
    if (!engineOptions.recognizer) {
      if (!engineOptions.modelDir) {
        throw new Error("MultiSpeakerStt: modelDir か recognizer のどちらかが必要です。");
      }
      this.sharedRecognizer = SttEngine.createRecognizer(engineOptions.modelDir);
    }
  }

  private createEngine(): SttEngine {
    return new SttEngine({
      ...this.engineOptions,
      recognizer: this.engineOptions.recognizer ?? this.sharedRecognizer,
    });
  }

  /** 指定話者のSttEngineを取得する。無ければ新規作成する。 */
  getEngine(speakerId: string): SttEngine {
    let engine = this.engines.get(speakerId);
    if (!engine) {
      engine = this.createEngine();
      this.engines.set(speakerId, engine);
    }
    return engine;
  }

  /**
   * 1発話セッション（Discordなら speaking start〜end の1区間）が終わった
   * 後や、デコードエラー等の異常系の後に呼ぶ。VAD内部状態とバッファを
   * リセットする（モデル自体は共有のまま再ロードしない、軽量な操作）。
   * `SttEngine.flush()` はこれを自動で呼ぶため、通常は明示呼び出し不要。
   * エラー経路（flush()を経由しない）でのフォローアップ用に用意している。
   */
  resetSpeaker(speakerId: string): void {
    this.engines.get(speakerId)?.reset();
  }

  /** 話者がボイスチャンネルを離れた等、もう使わなくなったら呼ぶ。 */
  removeSpeaker(speakerId: string): void {
    this.engines.delete(speakerId);
  }

  activeSpeakerCount(): number {
    return this.engines.size;
  }
}
