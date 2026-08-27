import { loadWakeWordConfig } from "../src/config.js";
import {
  DEFAULT_WAKE_WORD_CONFIG,
  detectWakeWord,
  stripWakeWord,
  type WakeWordConfig,
} from "../src/session/wakeword.js";

/**
 * ウェイクワード検出の位置限定マッチと、VAD/STTが前半の発話を同じ
 * セグメントに結合した場合の canonical 形式の検出を検証する。
 * 「んだもん」を許容リストに入れたことで、一般的な口語の語尾表現
 * 「〜んだもん」を誤検知しないか（冒頭一致に限定できているか）を確認する。
 */

const cases: [string, boolean, string, { previousUtterance?: string }?][] = [
  ["ずんだもん、こんにちは", true, "通常の呼びかけ"],
  ["ねえ、ずんだもん", true, "短いフィラー付き"],
  ["あっそうだんだもん、聞こえる？", true, "注意キュー付きで「んだもん」まで削れたケース"],
  ["すんだもん、天気教えて", true, "音素混同「すんだもん」"],
  [
    "夕方って仕事帰りの人も多いし道も結構混んでてさあそうだずんだもん明日の東京の天気を調べて",
    true,
    "実測の結合セグメント",
  ],
  ["ずんだもんって話題にして、ずんだもん天気を教えて", true, "ブロックされた後のcanonical一致"],
  ["あっそうだずんだも、天気を教えて", true, "同一セグメントの注意キュー+短縮形"],
  ["ああそうだ、淳も", true, "同一セグメントの注意キュー+同音候補"],
  ["そうだ。ズンダも", true, "同一セグメントの注意キュー+カナ候補"],
  ["淳太も来る", true, "直前の注意キューによる同音候補", { previousUtterance: "あっそうだ" }],
  ["ずんだも、質問がある", true, "直前の注意キューによる短縮形", { previousUtterance: "ああそうだ。" }],
  ["知らなかったんだもん", false, "口語の語尾表現(衝突してはいけない)"],
  ["別にいいもん、ずんだもんじゃなくても", false, "文中に出てくるだけ(冒頭ではない)"],
  ["ずんだもんってかわいいよね", false, "canonical形式の言及"],
  ["あっそうだずんだもち食べたい", false, "短縮形+食べ物語の誤検知をブロック"],
  ["ずんだもち食べたい", false, "直前のキューがあっても食べ物語はブロック", { previousUtterance: "あっそうだ" }],
  ["ずんだ餅を食べたい", false, "短いcanonical+食べ物語をブロック"],
  ["んだもん、聞こえる？", false, "短いweak候補はキューなしでは検出しない"],
  ["淳も来る", false, "キューなしの同音候補"],
  ["今日は天気がいいね", false, "無関係な発話"],
];

let allOk = true;
console.log("=== ウェイクワード検出テスト ===\n");
for (const [text, expected, label, context] of cases) {
  const actual = detectWakeWord(text, context);
  const ok = actual === expected;
  if (!ok) allOk = false;
  console.log(`  ${ok ? "PASS" : "FAIL"}  "${text}" -> ${actual} (期待${expected}) [${label}]`);
}

const stripCases: [string, string, string, { previousUtterance?: string }?][] = [
  ["ずんだもん、こんにちは", "こんにちは", "canonical形式を除去"],
  ["夕方の話。ずんだもん明日の天気", "夕方の話。明日の天気", "文中のcanonical形式を除去"],
  ["すんだもん、天気教えて", "天気教えて", "weak形式を除去"],
  ["あっそうだずんだも、こんにちは", "あっそうだ、こんにちは", "同一セグメントで受理した短縮形を除去"],
  ["ずんだも", "", "直前の注意キューで受理した短縮形を除去", { previousUtterance: "あっそうだ" }],
  ["ずんだもち食べたい", "ずんだもち食べたい", "食べ物語の短縮形は除去しない", { previousUtterance: "あっそうだ" }],
  ["知らなかったんだもん", "知らなかったんだもん", "口語の語尾を除去しない"],
  ["ずんだもんってかわいいよね", "ずんだもんってかわいいよね", "言及を除去しない"],
];

console.log("\n=== ウェイクワード除去テスト ===\n");
for (const [text, expected, label, context] of stripCases) {
  const actual = stripWakeWord(text, context);
  const ok = actual === expected;
  if (!ok) allOk = false;
  console.log(`  ${ok ? "PASS" : "FAIL"}  "${text}" -> "${actual}" (期待"${expected}") [${label}]`);
}

const alternateConfig: WakeWordConfig = {
  canonical: ["アシスタント", "コンピューター"],
  weak: ["アシスタン"],
  ambiguous: ["アシス", "コンピュ"],
  attentionCues: ["ねえ", "ちょっと"],
  blockedCanonicalSuffixes: ["って", "では"],
  blockedAmbiguousSuffixes: ["餅"],
  weakMaxStartIndex: 3,
  attentionCueMaxGap: 6,
};

console.log("\n=== カスタム設定テスト ===\n");
const customCases: [boolean, string][] = [
  [detectWakeWord("アシスタント、こんにちは", { config: alternateConfig }), "canonical候補1"],
  [detectWakeWord("コンピューター、質問です", { config: alternateConfig }), "canonical候補2"],
  [detectWakeWord("ねえ、アシス", { config: alternateConfig }), "追加した曖昧候補"],
  [stripWakeWord("コンピュ", {
    config: alternateConfig,
    previousUtterance: "ちょっと",
  }) === "", "追加した曖昧候補のstrip"],
  [!detectWakeWord("アシスタントって便利", { config: alternateConfig }), "customの言及ブロック"],
  [!detectWakeWord("ねえアシス餅", { config: alternateConfig }), "customの食べ物語ブロック"],
];
for (const [ok, label] of customCases) {
  if (!ok) allOk = false;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
}

const envConfig = loadWakeWordConfig({
  WAKE_WORDS: "アシスタント, コンピューター",
  WAKE_WORD_AMBIGUOUS_ALIASES: "アシス,コンピュ",
  WAKE_ATTENTION_CUES: "ねえ,ちょっと",
});
let shortCanonicalRejected = false;
try {
  loadWakeWordConfig({ WAKE_WORDS: "ずんだ" });
} catch {
  shortCanonicalRejected = true;
}
const fiveCharacterAccepted = loadWakeWordConfig({ WAKE_WORDS: "ずんだもん" }).canonical;
const multipleCanonicalAccepted = loadWakeWordConfig({
  WAKE_WORDS: "四国めたん,めたんちゃん,ちゃっぴー",
}).canonical;
const envConfigOk =
  JSON.stringify(envConfig.canonical) === JSON.stringify(["アシスタント", "コンピューター"]) &&
  envConfig.weak.length === 0 &&
  JSON.stringify(envConfig.ambiguous) === JSON.stringify(["アシス", "コンピュ"]) &&
  JSON.stringify(envConfig.attentionCues) === JSON.stringify(["ねえ", "ちょっと"]) &&
  JSON.stringify(loadWakeWordConfig({}).canonical) ===
    JSON.stringify(DEFAULT_WAKE_WORD_CONFIG.canonical) &&
  shortCanonicalRejected &&
  fiveCharacterAccepted.length === 1 &&
  multipleCanonicalAccepted.length === 3;
if (!envConfigOk) allOk = false;
console.log(`  ${envConfigOk ? "PASS" : "FAIL"}  .envのカンマ区切り設定、文字数検証、複数canonical`);

const replacedWithoutAliases = loadWakeWordConfig({ WAKE_WORDS: "四国めたん" });
const oldCharacterAliasesCleared =
  replacedWithoutAliases.weak.length === 0 && replacedWithoutAliases.ambiguous.length === 0;
if (!oldCharacterAliasesCleared) allOk = false;
console.log(
  `  ${oldCharacterAliasesCleared ? "PASS" : "FAIL"}  canonical置換時に旧キャラクターの別名を残さない`,
);

console.log(`\n${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
