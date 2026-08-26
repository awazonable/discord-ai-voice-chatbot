import { detectWakeWord } from "../src/session/wakeword.js";

/**
 * ウェイクワード検出の位置限定マッチを検証する。
 * 「んだもん」を許容リストに入れたことで、一般的な口語の語尾表現
 * 「〜んだもん」を誤検知しないか（冒頭一致に限定できているか）を確認する。
 */

const cases: [string, boolean, string][] = [
  ["ずんだもん、こんにちは", true, "通常の呼びかけ"],
  ["ねえ、ずんだもん", true, "短いフィラー付き"],
  ["んだもん、聞こえる？", true, "冒頭が「んだもん」まで削れたケース"],
  ["すんだもん、天気教えて", true, "音素混同「すんだもん」"],
  ["知らなかったんだもん", false, "口語の語尾表現(衝突してはいけない)"],
  ["別にいいもん、ずんだもんじゃなくても", false, "文中に出てくるだけ(冒頭ではない)"],
  ["今日は天気がいいね", false, "無関係な発話"],
];

let allOk = true;
console.log("=== ウェイクワード検出テスト ===\n");
for (const [text, expected, label] of cases) {
  const actual = detectWakeWord(text);
  const ok = actual === expected;
  if (!ok) allOk = false;
  console.log(`  ${ok ? "PASS" : "FAIL"}  "${text}" -> ${actual} (期待${expected}) [${label}]`);
}

console.log(`\n${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
