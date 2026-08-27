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
/** ウェイクワードの語彙と、曖昧候補を受理するための安全策。 */
export interface WakeWordConfig {
  /** 通常のウェイクワード。テキスト中のどこにあっても検出する。 */
  canonical: readonly string[];
  /** ASRで先頭が欠けたが、冒頭位置なら受理する候補。 */
  weak: readonly string[];
  /** 注意キューがある場合だけ受理する短縮・同音候補。 */
  ambiguous: readonly string[];
  /** 曖昧候補の直前に置ける注意キュー。 */
  attentionCues: readonly string[];
  /** canonicalの直後に続くと、言及・否定としてブロックする語。 */
  blockedCanonicalSuffixes: readonly string[];
  /** 曖昧候補の直後に続くと、食べ物語などとしてブロックする語。 */
  blockedAmbiguousSuffixes: readonly string[];
  weakMaxStartIndex?: number;
  attentionCueMaxGap?: number;
}

/** 既存のずんだもん検知と互換な既定設定。アプリ・ライブラリから差し替え可能。 */
export const DEFAULT_WAKE_WORD_CONFIG: WakeWordConfig = {
  canonical: ["ずんだもん", "ずんちゃん"],
  weak: ["すんだもん", "すんだもーん", "んだもーん"],
  ambiguous: ["ずんだも", "ズンダも", "淳も", "淳太も", "んだもん"],
  attentionCues: ["あっそうだ", "ああそうだ", "そうだ"],
  blockedCanonicalSuffixes: ["じゃ", "では", "って", "という", "餅", "もち"],
  blockedAmbiguousSuffixes: ["ち", "チ", "餅", "もち"],
  weakMaxStartIndex: 3,
  attentionCueMaxGap: 6,
};

const MIN_CANONICAL_UNICODE_LENGTH = 5;

export class WakeWordConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WakeWordConfigError";
  }
}

export interface WakeWordContext {
  /** 同じ話者の直前のfinal発話。曖昧候補の補助キューにのみ使う。 */
  previousUtterance?: string;
}

export interface WakeWordOptions extends WakeWordContext {
  config?: WakeWordConfig;
}

export function detectWakeWord(text: string, options: WakeWordOptions = {}): boolean {
  const config = resolveWakeWordConfig(options.config);
  const trimmed = text.trimStart();
  const prioritizedMatches = getPrioritizedMatches(trimmed, config);
  const canonicalMatches = prioritizedMatches
    .filter((match) => match.kind === "canonical")
    .map(({ index, word }) => ({ index, word }));

  if (canonicalMatches.some(({ index, word }) => !isBlockedSuffix(trimmed, index, word, config))) {
    return true;
  }

  if (prioritizedMatches.some(
    ({ kind, index }) => kind === "weak" &&
      index <= (config.weakMaxStartIndex ?? DEFAULT_WAKE_WORD_CONFIG.weakMaxStartIndex!),
  )) {
    return true;
  }

  return prioritizedMatches.some((match) =>
    match.kind === "ambiguous" &&
    isAcceptedAmbiguousMatch(trimmed, match, canonicalMatches, options, config),
  );
}

/** ウェイクワード部分を取り除いた残りのテキストを返す（本題抽出用） */
export function stripWakeWord(text: string, options: WakeWordOptions = {}): string {
  const config = resolveWakeWordConfig(options.config);
  const trimmed = text.trimStart();
  const prioritizedMatches = getPrioritizedMatches(trimmed, config);
  const canonicalMatches = prioritizedMatches
    .filter((match) => match.kind === "canonical")
    .map(({ index, word }) => ({ index, word }));
  const canonicalToStrip = canonicalMatches.filter(
    ({ index, word }) => !isBlockedSuffix(trimmed, index, word, config),
  );
  const weakToStrip = prioritizedMatches
    .filter((match) =>
      match.kind === "weak" &&
      match.index <= (config.weakMaxStartIndex ?? DEFAULT_WAKE_WORD_CONFIG.weakMaxStartIndex!),
    )
    .map(({ index, word }) => ({ index, word }));
  const ambiguousToStrip = prioritizedMatches.filter((match) =>
    match.kind === "ambiguous" &&
    isAcceptedAmbiguousMatch(trimmed, match, canonicalMatches, options, config),
  );
  const matches = selectNonOverlapping([
    ...canonicalToStrip,
    ...weakToStrip,
    ...ambiguousToStrip,
  ]).sort(
    (a, b) => b.index - a.index,
  );

  let result = trimmed;
  for (const match of matches) {
    result = result.slice(0, match.index) + result.slice(match.index + match.word.length);
  }
  return result.trim().replace(/^[、。,.\s]+/, "");
}
function findMatches(text: string, words: readonly string[]) {
  return words.flatMap((word) => {
    const matches: { index: number; word: string }[] = [];
    let index = text.indexOf(word);
    while (index !== -1) {
      matches.push({ index, word });
      index = text.indexOf(word, index + 1);
    }
    return matches;
  });
}

type WakeWordMatch = { index: number; word: string };
type PrioritizedWakeWordMatch = WakeWordMatch & {
  kind: "canonical" | "weak" | "ambiguous";
};

function getPrioritizedMatches(text: string, config: WakeWordConfig): PrioritizedWakeWordMatch[] {
  return selectNonOverlapping([
    ...findMatches(text, config.canonical).map((match) => ({ ...match, kind: "canonical" as const })),
    ...findMatches(text, config.weak)
      .filter(({ word }) => unicodeLength(word) >= MIN_CANONICAL_UNICODE_LENGTH)
      .map((match) => ({ ...match, kind: "weak" as const })),
    ...findMatches(text, [
      ...config.ambiguous,
      ...config.weak.filter((word) => unicodeLength(word) < MIN_CANONICAL_UNICODE_LENGTH),
    ]).map((match) => ({ ...match, kind: "ambiguous" as const })),
  ]);
}

function selectNonOverlapping<T extends WakeWordMatch>(matches: T[]): T[] {
  const selected: T[] = [];
  for (const match of matches.sort((a, b) => a.index - b.index || b.word.length - a.word.length)) {
    if (!selected.some((other) => overlaps(match.index, match.word.length, other.index, other.word.length))) {
      selected.push(match);
    }
  }
  return selected;
}

function isBlockedSuffix(
  text: string,
  index: number,
  word: string,
  config: WakeWordConfig,
): boolean {
  const suffix = text.slice(index + word.length);
  return config.blockedCanonicalSuffixes.some((blocked) => suffix.startsWith(blocked));
}

function isBlockedAmbiguousSuffix(
  text: string,
  index: number,
  word: string,
  config: WakeWordConfig,
): boolean {
  const suffix = text.slice(index + word.length);
  return config.blockedAmbiguousSuffixes.some((blocked) => suffix.startsWith(blocked));
}

function isAcceptedAmbiguousMatch(
  text: string,
  match: WakeWordMatch,
  canonicalMatches: WakeWordMatch[],
  options: WakeWordOptions,
  config: WakeWordConfig,
): boolean {
  if (
    canonicalMatches.some((canonical) =>
      overlaps(match.index, match.word.length, canonical.index, canonical.word.length),
    )
  ) {
    return false;
  }
  if (isBlockedAmbiguousSuffix(text, match.index, match.word, config)) {
    return false;
  }

  return (
    hasAttentionCueBefore(text, match.index, config) ||
    isAttentionCue(options.previousUtterance, config)
  );
}

function hasAttentionCueBefore(
  text: string,
  variantIndex: number,
  config: WakeWordConfig,
): boolean {
  const prefix = text.slice(0, variantIndex);
  const cueGap = `[、。,.!?！？\\s]{0,${config.attentionCueMaxGap ?? DEFAULT_WAKE_WORD_CONFIG.attentionCueMaxGap!}}`;
  return config.attentionCues.some((cue) =>
    new RegExp(`${[...cue].map(escapeRegExp).join(cueGap)}${cueGap}$`).test(prefix),
  );
}

function isAttentionCue(text: string | undefined, config: WakeWordConfig): boolean {
  if (!text) return false;
  const normalized = normalizeCue(text);
  return config.attentionCues.some((cue) => normalizeCue(cue) === normalized);
}

function resolveWakeWordConfig(config?: WakeWordConfig): WakeWordConfig {
  const resolved = config ?? DEFAULT_WAKE_WORD_CONFIG;
  validateWakeWordConfig(resolved);
  return resolved;
}

export function validateWakeWordConfig(config: WakeWordConfig): void {
  validateWordList("canonical", config.canonical, MIN_CANONICAL_UNICODE_LENGTH);
  validateWordList("weak", config.weak);
  validateWordList("ambiguous", config.ambiguous);
  validateWordList("attentionCues", config.attentionCues);
  validateWordList("blockedCanonicalSuffixes", config.blockedCanonicalSuffixes);
  validateWordList("blockedAmbiguousSuffixes", config.blockedAmbiguousSuffixes);
}

function validateWordList(name: string, words: readonly string[], minUnicodeLength = 1): void {
  if (!Array.isArray(words)) {
    throw new WakeWordConfigError(`${name} は文字列配列で指定してください。`);
  }
  for (const word of words) {
    const trimmed = word.trim();
    if (!trimmed || unicodeLength(trimmed) < minUnicodeLength) {
      throw new WakeWordConfigError(
        `${name} の「${word}」はUnicode文字数${unicodeLength(trimmed)}文字です。` +
        `${minUnicodeLength}文字以上の値を指定してください。`,
      );
    }
  }
}

function unicodeLength(text: string): number {
  return [...text].length;
}

function normalizeCue(text: string): string {
  return text.trim().replace(/[、。,.!?！？\s]/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function overlaps(index: number, length: number, otherIndex: number, otherLength: number) {
  return index < otherIndex + otherLength && otherIndex < index + length;
}
