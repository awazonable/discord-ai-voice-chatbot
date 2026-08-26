// 実測(sherpa-onnx + ReazonSpeech Zipformer)で、発話冒頭の「ずんだもん」が
// デコード時に「すんだもん」に寄る傾向を確認した(「ずんだ」は一般語彙が
// 少なくASRが「ず」を「す」に寄せがち)。decodeSegment側の無音パディングで
// 大幅に改善したため、この程度の許容は入れておく。
//
// 別の原因として、VAD自体が発話区間の先頭(オンセット)検出に失敗し、
// 「ず」の音声そのものを区間に含めない場合もあり、その場合は「んだもん」
// まで削れてしまうことも実測で確認した。ただし「んだもん」は
// 「〜んだもん」という一般的な日本語の口語表現の語尾と衝突するため、
// 単純な部分一致では誤検知が多発する。ここでは対応せず、根本対策
// （VAD区間の前にpre-rollバッファを足す）を要検討事項として
// docs/openai-test-handoff.md に記録するに留める。
const WAKE_WORDS = ["ずんだもん", "ずんだもーん", "すんだもん", "すんだもーん"];

export function detectWakeWord(text: string): boolean {
  return WAKE_WORDS.some((w) => text.includes(w));
}

/** ウェイクワード部分を取り除いた残りのテキストを返す（本題抽出用） */
export function stripWakeWord(text: string): string {
  let result = text;
  for (const w of WAKE_WORDS) {
    result = result.split(w).join("");
  }
  return result.trim().replace(/^[、。,.\s]+/, "");
}
