const WAKE_WORDS = ["ずんだもん", "ずんだもーん"];

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
