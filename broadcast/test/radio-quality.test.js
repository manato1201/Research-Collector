// ラジオ原稿の品質(重複を読まない・英語の題名を読み上げない・解説のある記事を先に・語の途中で切らない)
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRadioProgram, firstSentence } from "../public/radio-script.js";

const art = (i, over = {}) => ({
  url_hash: String(i).padStart(16, "0"),
  title: `Article ${i}: Added a toggle to cook options`,
  summary: "Added a toggle to the cook options so that editing does not recompile the asset every time.",
  platform: "sidefx_changelog",
  ...over,
});
const ai = (what, use = "待ち時間を減らせます") => ({ what, use, apply: "案件で試せそうです", source: "ai" });

test("an item that belongs to two categories is read in the first corner only", () => {
  const shared = art(1);
  const p = buildRadioProgram({
    date: "2026-10-14",
    total: 6,
    highlights: [],
    insights: {},
    lanes: [
      { id: "game_dev_tech", label: "G", count: 3, items: [shared, art(2), art(3)] },
      { id: "graphics_research", label: "R", count: 3, items: [shared, art(4), art(5)] },
    ],
  });
  const g = p.corners.find((c) => c.id === "game_dev_tech").text;
  const r = p.corners.find((c) => c.id === "graphics_research").text;
  assert.ok(g.includes("Article 1:"));
  assert.ok(!r.includes("Article 1:"), "the shared article must not be read twice");
  assert.ok(r.includes("Article 4:"));
});

test("a corner whose items were all read earlier is dropped", () => {
  const a = art(1);
  const p = buildRadioProgram({
    date: "2026-10-14",
    total: 1,
    highlights: [a],
    lanes: [{ id: "game_dev_tech", label: "G", count: 1, items: [a] }],
  });
  assert.deepEqual(
    p.corners.map((c) => c.id),
    ["open", "headlines", "close"],
  );
});

test("an English-only title is not read aloud when an AI insight in Japanese is available", () => {
  const a = art(1, { title: "22.0.471: HDAs can now disable the scan for PDG networks" });
  const p = buildRadioProgram({
    date: "2026-10-14",
    total: 1,
    highlights: [a],
    insights: { [a.url_hash]: ai("PDG のスキャンを止められる機能です") },
    lanes: [],
  });
  const h = p.corners.find((c) => c.id === "headlines").text;
  assert.ok(h.includes("PDG のスキャンを止められる機能です。待ち時間を減らせます。"));
  assert.ok(!h.includes("22.0.471"), h);
});

test("a Japanese title is still read, followed by the insight", () => {
  const a = art(1, { title: "uGUIのリビルドの仕組み" });
  const p = buildRadioProgram({
    date: "2026-10-14",
    total: 1,
    highlights: [a],
    insights: { [a.url_hash]: ai("リビルドが重くなる理由の解説です") },
    lanes: [],
  });
  const h = p.corners.find((c) => c.id === "headlines").text;
  assert.ok(h.includes("uGUIのリビルドの仕組み。リビルドが重くなる理由の解説です。"));
});

test("items with an AI insight are read before those without", () => {
  const plain = [art(1), art(2), art(3)];
  const withAi = art(9, { title: "Zenn の記事" });
  const p = buildRadioProgram({
    date: "2026-10-14",
    total: 4,
    highlights: [],
    insights: { [withAi.url_hash]: ai("要点の解説です") },
    lanes: [{ id: "game_dev_tech", label: "G", count: 4, items: [...plain, withAi] }],
    perCorner: 2,
  });
  const g = p.corners.find((c) => c.id === "game_dev_tech").text;
  assert.ok(g.indexOf("要点の解説です") >= 0 && g.indexOf("要点の解説です") < g.indexOf("Article 1:"), g);
});

test("firstSentence does not cut in the middle of an English word", () => {
  const s = firstSentence("Added a toggle to the cook options so that editing does not recompile the asset every time", 40);
  assert.ok(s.length <= 40);
  assert.ok(!/\s\w$/.test(s) || s.endsWith(" a"), s); // 単語の途中(1文字だけ残る等)で終わらない
  assert.ok("Added a toggle to the cook options so that editing does not recompile".startsWith(s));
});
