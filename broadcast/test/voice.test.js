// 読み上げの声の選び方の単体テスト
import assert from "node:assert/strict";
import { test } from "node:test";

import { isHighQuality, pickBestVoice, rankVoices, voiceLabel, voiceScore } from "../public/voice.js";

const v = (name, over = {}) => ({ name, lang: "ja-JP", localService: true, ...over });
const win = [
  v("Microsoft Haruka - Japanese (Japan)"),
  v("Microsoft Ayumi - Japanese (Japan)"),
  v("Google 日本語", { localService: false }),
  v("Microsoft Nanami Online (Natural) - Japanese (Japan)", { localService: false }),
  v("Microsoft David - English (United States)", { lang: "en-US" }),
];

test("the most natural voice is chosen by default, not the first one the browser lists", () => {
  assert.equal(pickBestVoice(win).name, "Microsoft Nanami Online (Natural) - Japanese (Japan)");
});

test("without a natural voice, Google's is preferred over the standard on-device voices", () => {
  assert.equal(pickBestVoice(win.filter((x) => !x.name.includes("Nanami"))).name, "Google 日本語");
});

test("Apple Premium / Enhanced voices rank above compact ones", () => {
  const mac = [v("Kyoko"), v("O-Ren (Enhanced)"), v("Otoya (Premium)")];
  assert.ok(["O-Ren (Enhanced)", "Otoya (Premium)"].includes(pickBestVoice(mac).name));
});

test("a voice the user chose explicitly wins, if it still exists", () => {
  assert.equal(pickBestVoice(win, "Microsoft Ayumi - Japanese (Japan)").name, "Microsoft Ayumi - Japanese (Japan)");
  assert.equal(pickBestVoice(win, "gone").name, "Microsoft Nanami Online (Natural) - Japanese (Japan)");
});

test("non-Japanese voices are never picked; no Japanese voice -> null", () => {
  assert.equal(pickBestVoice([v("David", { lang: "en-US" })]), null);
  assert.equal(pickBestVoice([]), null);
  assert.equal(rankVoices(win).length, 4);
});

test("robotic voices come last; ties keep the original order", () => {
  const list = [v("eSpeak ja"), v("Alpha"), v("Beta")];
  assert.deepEqual(rankVoices(list).map((x) => x.name), ["Alpha", "Beta", "eSpeak ja"]);
  assert.ok(voiceScore(v("eSpeak ja")) < 0);
});

test("labels mark high-quality voices", () => {
  assert.ok(voiceLabel(v("X Online (Natural)")).includes("★高品質"));
  assert.equal(voiceLabel(v("Microsoft Haruka")), "Microsoft Haruka");
  assert.equal(isHighQuality(v("Google 日本語")), true);
});
