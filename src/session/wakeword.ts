// 実測(sherpa-onnx + ReazonSpeech Zipformer)で、発話冒頭の「ずんだもん」が
// デコード時に「すんだもん」に寄る傾向を確認した(「ずんだ」は一般語彙が
// 少なくASRが「ず」を「す」に寄せがち)。decodeSegment側の無音パディングで
// 大幅に改善したため、この程度の許容は入れておく。
//
// 「んだもん」まで削れて渡ってくることも実測で確認したが、これは
// 「〜んだもん」という一般的な日本語の口語表現の語尾（例:
// 「知らなかったんだもん」）と衝突するため、単純な部分一致では
// 誤検知が多発する。Opusによるレビュー(CLAUDE.md参照)で、ウェイクワードは
// 本来発話の"冒頭"に来る前提なので、一致位置を制限すれば安全に許容できる
// と指摘された。「ねえ、ずんだもん」のような短いフィラーは許容しつつ、
// 文の後半に出てくる口語の語尾とは区別する。
const WAKE_WORDS = [
  "ずんだもん",
  "ずんだもーん",
  "すんだもん",
  "すんだもーん",
  "んだもん",
  "んだもーん",
];

/**
 * ウェイクワードがこの文字数以内で始まっていれば「冒頭」とみなす。
 * 「ねえ、」「あの、」程度の短いフィラーは許容しつつ、「知らなかった
 * んだもん」(6文字の節の後に続く口語表現)のような衝突は避ける値。
 */
const WAKE_WORD_MAX_START_INDEX = 3;

export function detectWakeWord(text: string): boolean {
  const trimmed = text.trimStart();
  return WAKE_WORDS.some((w) => {
    const idx = trimmed.indexOf(w);
    return idx !== -1 && idx <= WAKE_WORD_MAX_START_INDEX;
  });
}

/** ウェイクワード部分を取り除いた残りのテキストを返す（本題抽出用） */
export function stripWakeWord(text: string): string {
  let result = text;
  for (const w of WAKE_WORDS) {
    result = result.split(w).join("");
  }
  return result.trim().replace(/^[、。,.\s]+/, "");
}
