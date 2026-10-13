// ラジオ原稿の生成の単体テスト(DOM に依存しないので node で動く)
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRadioProgram,
  cleanTitle,
  estimateSeconds,
  firstSentence,
  formatClock,
  greeting,
  normalizeForSpeech,
  spokenDate,
} from "../public/radio-script.js";

test("greeting follows the hour (JST)", () => {
  assert.equal(greeting(6), "おはようございます");
  assert.equal(greeting(13), "こんにちは");
  assert.equal(greeting(20), "こんばんは");
  assert.equal(greeting(2), "こんばんは");
});

test("spoken date drops the year and leading zeros", () => {
  assert.equal(spokenDate("2026-10-05"), "10月5日");
  assert.equal(spokenDate("bad"), "bad");
});

test("speech normalization: urls, emoji and terms are handled", () => {
  const s = normalizeForSpeech("Unity 6 の URP を GPU で https://example.com/x 🎮 2026-10-12 公開");
  assert.ok(!s.includes("http"));
  assert.ok(!/🎮/u.test(s));
  assert.ok(s.includes("ユニティ"));
  assert.ok(s.includes("ユーアールピー"));
  assert.ok(s.includes("ジーピーユー"));
  assert.ok(s.includes("2026年10月12日"));
});

test("speech normalization keeps unknown words and does not break plain Japanese", () => {
  assert.equal(normalizeForSpeech("週次のまとめです。"), "週次のまとめです。");
  assert.equal(normalizeForSpeech("Foo Bar"), "Foo Bar");
  assert.equal(normalizeForSpeech(""), "");
  assert.equal(normalizeForSpeech(null), "");
});

test("firstSentence and cleanTitle", () => {
  assert.equal(firstSentence("最初の文です。二つ目です。"), "最初の文です。");
  assert.equal(firstSentence("a".repeat(200), 20).length, 19);
  assert.equal(firstSentence(""), "");
  assert.equal(cleanTitle('22.0.468: Added "Invert Option + Swipe...'), '22.0.468: Added "Invert Option + Swipe');
});

test("estimate and clock", () => {
  assert.equal(estimateSeconds("あ".repeat(65)), 10);
  assert.equal(estimateSeconds("あ".repeat(65), 2), 5);
  assert.equal(formatClock(75), "01:15");
});

const item = (t, s = "") => ({ title: t, summary: s });
const program = (over = {}) =>
  buildRadioProgram({
    date: "2026-10-12",
    hour: 7,
    total: 34,
    highlights: [item("注目A", "Aの説明です。"), item("注目B"), item("注目C"), item("注目D")],
    lanes: [
      {
        id: "game_dev_tech",
        label: "Game-Dev-Tech",
        count: 24,
        items: Array.from({ length: 6 }, (_, i) => item(`G${i}`, `要約${i}。`)),
      },
      { id: "graphics_research", label: "Graphics-Research", count: 0, items: [] },
      { id: "software_engineering", label: "Software-Engineering", count: 3, items: [item("S0"), item("S1"), item("S2")] },
    ],
    ...over,
  });

test("program: opening, headlines, one corner per non-empty category, ending", () => {
  const p = program();
  assert.deepEqual(
    p.corners.map((c) => c.id),
    ["open", "headlines", "game_dev_tech", "software_engineering", "close"],
  );
  assert.equal(p.corners[0].jingle, "open");
  assert.equal(p.corners.at(-1).jingle, "close");
  assert.ok(p.corners[0].text.startsWith("おはようございます"));
  assert.ok(p.corners[0].text.includes("全部で34件"));
  assert.ok(p.corners[0].text.includes("ゲーム開発が24件"));
  assert.ok(!p.corners[0].text.includes("グラフィクスが"), "empty categories are not announced");
});

test("program: headlines are capped at three and numbered", () => {
  const p = program();
  const h = p.corners.find((c) => c.id === "headlines").text;
  assert.ok(h.includes("1本目。注目A") && h.includes("3本目。注目C"));
  assert.ok(!h.includes("注目D"));
});

test("program: a corner reads at most four items and mentions the rest", () => {
  const p = program();
  const g = p.corners.find((c) => c.id === "game_dev_tech").text;
  assert.ok(g.includes("G3") && !g.includes("G4"));
  assert.ok(g.includes("ほか20件は、サイトでご覧ください"));
  const s = p.corners.find((c) => c.id === "software_engineering").text;
  assert.ok(!s.includes("ほか"));
});

test("program: every corner has speech text and a positive duration; total is the sum", () => {
  const p = program();
  assert.ok(p.corners.every((c) => c.speech.length > 0 && c.seconds >= 1));
  assert.equal(
    p.totalSeconds,
    p.corners.reduce((n, c) => n + c.seconds, 0),
  );
});

test("program: a day without news is still a valid (short) program", () => {
  const p = program({ total: 0, highlights: [], lanes: [] });
  assert.deepEqual(
    p.corners.map((c) => c.id),
    ["open", "close"],
  );
  assert.ok(p.corners[0].text.includes("新着がありません"));
});

test("program: the summary is not repeated when it just restates the title", () => {
  const p = program({
    highlights: [item("Unityの新機能を発表した", "Unityの新機能を発表した。詳細は公式ブログへ。")],
  });
  const h = p.corners.find((c) => c.id === "headlines").text;
  assert.equal(h.split("Unityの新機能を発表した").length - 1, 1);
});
