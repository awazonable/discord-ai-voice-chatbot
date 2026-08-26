// @ts-nocheck  sherpa-onnx-node は型定義を配布していないため素通しで扱う
import sherpa_onnx from "sherpa-onnx-node";

export interface SttEngineOptions {
  modelDir: string;
  vadModelPath: string;
  /** VAD/認識モデルが要求するサンプルレート。sherpa-onnxのReazonSpeechモデルは16kHz。 */
  sampleRate?: number;
  /** 無音判定の閾値(秒)。stt-design.mdの初期値を踏襲。 */
  minSilenceDurationSec?: number;
}

export interface RecognizedSegment {
  text: string;
  /** 発話区間(VADが検出した音声部分)の長さ(ms)。 */
  durationMs: number;
  /** 認識にかかった時間(ms)。 */
  decodeMs: number;
}

/**
 * VAD(Silero)による発話区間検出 + オフライン認識(ReazonSpeech Zipformer)。
 *
 * stt-design.md はストリーミング認識による「partial: 0.5秒間隔で更新」を
 * 想定していたが、k2-fsaが配布しているReazonSpeechのsherpa-onnxエクスポート
 * (sherpa-onnx-zipformer-ja-reazonspeech-*)はオフライン(発話全体を一括
 * デコード)用で、真のストリーミング部分認識はできない。
 * 代わりに「VADが発話区間を検出→区間ごとに一括認識」という構成にした。
 * finalの確定タイミング(無音検出と同時)はstt-design.mdの方針と両立する。
 * partial表示が必要になった場合は、ストリーミング対応モデル
 * （"streaming"を含むモデル名）への差し替えを検討すること。
 */
export class SttEngine {
  private vad: InstanceType<typeof sherpa_onnx.Vad>;
  private recognizer: InstanceType<typeof sherpa_onnx.OfflineRecognizer>;
  private buffer: InstanceType<typeof sherpa_onnx.CircularBuffer>;
  private resampler: InstanceType<typeof sherpa_onnx.LinearResampler> | null = null;
  private resamplerInputRate: number | null = null;
  private windowSize: number;
  private targetSampleRate: number;

  constructor(opts: SttEngineOptions) {
    this.targetSampleRate = opts.sampleRate ?? 16000;

    this.recognizer = new sherpa_onnx.OfflineRecognizer({
      modelConfig: {
        transducer: {
          encoder: `${opts.modelDir}/encoder-epoch-99-avg-1.int8.onnx`,
          decoder: `${opts.modelDir}/decoder-epoch-99-avg-1.onnx`,
          joiner: `${opts.modelDir}/joiner-epoch-99-avg-1.int8.onnx`,
        },
        tokens: `${opts.modelDir}/tokens.txt`,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });

    const windowSize = 512;
    this.vad = new sherpa_onnx.Vad(
      {
        sileroVad: {
          model: opts.vadModelPath,
          threshold: 0.5,
          minSpeechDuration: 0.25,
          minSilenceDuration: opts.minSilenceDurationSec ?? 0.35,
          windowSize,
        },
        sampleRate: this.targetSampleRate,
        debug: false,
        numThreads: 1,
      },
      60
    );
    this.windowSize = windowSize;
    this.buffer = new sherpa_onnx.CircularBuffer(30 * this.targetSampleRate);
  }

  /**
   * PCMサンプルを受け取る。sourceSampleRateがモデルの想定と異なれば
   * 内部でリサンプルする。確定した発話区間があればテキストを返す。
   */
  pushSamples(
    samples: Float32Array,
    sourceSampleRate: number,
    onRawSegment?: (samples: Float32Array) => void
  ): RecognizedSegment[] {
    let resampled = samples;
    if (sourceSampleRate !== this.targetSampleRate) {
      if (!this.resampler || this.resamplerInputRate !== sourceSampleRate) {
        this.resampler = new sherpa_onnx.LinearResampler(
          sourceSampleRate,
          this.targetSampleRate
        );
        this.resamplerInputRate = sourceSampleRate;
      }
      resampled = this.resampler.resample(samples);
    }

    this.buffer.push(resampled);
    while (this.buffer.size() >= this.windowSize) {
      const chunk = this.buffer.get(this.buffer.head(), this.windowSize);
      this.buffer.pop(this.windowSize);
      this.vad.acceptWaveform(chunk);
    }

    const results: RecognizedSegment[] = [];
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front();
      this.vad.pop();
      onRawSegment?.(segment.samples);
      const r = this.decodeSegment(segment.samples);
      if (r) results.push(r);
    }
    return results;
  }

  /** 入力ストリームが終わったことを通知し、バッファに残っている分を確定させる。 */
  flush(): RecognizedSegment[] {
    this.vad.flush();
    const results: RecognizedSegment[] = [];
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front();
      this.vad.pop();
      const r = this.decodeSegment(segment.samples);
      if (r) results.push(r);
    }
    return results;
  }

  private decodeSegment(rawSamples: Float32Array): RecognizedSegment | null {
    // VADが切り出した区間の先頭付近が、そのまま認識にかけると欠落する
    // ことを実測で確認した(「ずんだもん」の冒頭「ず」が消える等)。
    // 無音パディングを足すことでほぼ解消する
    // (src/_scratchPadding.ts での実験。pad>=0.1sで大幅改善、
    //  0.2s以上でほぼ安定)。
    const leadingSamples = Math.floor(this.targetSampleRate * 0.3);
    const trailingSamples = Math.floor(this.targetSampleRate * 0.1);
    const padded = new Float32Array(leadingSamples + rawSamples.length + trailingSamples);
    padded.set(rawSamples, leadingSamples);

    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples: padded, sampleRate: this.targetSampleRate });
    const started = Date.now();
    this.recognizer.decode(stream);
    const decodeMs = Date.now() - started;
    const result = this.recognizer.getResult(stream);

    const text = result.text.trim();
    if (text.length === 0) return null;
    return {
      text,
      durationMs: (rawSamples.length / this.targetSampleRate) * 1000,
      decodeMs,
    };
  }
}
