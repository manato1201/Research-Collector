// 図に渡す行の整形と、ラジオの画面(slide)の単体テスト
import assert from "node:assert/strict";
import { test } from "node:test";

import { categoryRows, dayLabel, hasFigureData, sourceRows, trendRows } from "../public/figure-data.js";
import { buildRadioProgram } from "../public/radio-script.js";

test("categoryRows: one row per category with its count and class; junk counts become 0", () => {
  const rows = categoryRows({ game_dev_tech: 24, graphics_research: "3", software_engineering: null }, (id) => `L:${id}`);
  assert.deepEqual(rows, [
    { label: "L:game_dev_tech", value: 24, cls: "game_dev_tech" },
    { label: "L:graphics_research", value: 3, cls: "graphics_research" },
    { label: "L:software_engineering", value: 0, cls: "software_engineering" },
  ]);
  assert.deepEqual(categoryRows(null, String), []);
});

test("sourceRows: top sources, the rest summed into 'ほか' (nothing is invented or dropped)", () => {
  const src = [["a", 9], ["b", 7], ["c", 5], ["d", 3], ["e", 2], ["f", 1]].map(([platform, count]) => ({ platform, count }));
  const rows = sourceRows(src, 5);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.at(-1), { label: "ほか", value: 3 }); // e(2) + f(1)
  assert.equal(rows.reduce((n, r) => n + r.value, 0), 27);
  assert.deepEqual(sourceRows(src.slice(0, 2), 5).map((r) => r.label), ["a", "b"]);
  assert.deepEqual(sourceRows([{ platform: "x", count: 0 }, null], 5), []);
});

test("trendRows / dayLabel / hasFigureData", () => {
  assert.equal(dayLabel("2026-10-05"), "10/5");
  assert.equal(dayLabel("bad"), "bad");
  assert.deepEqual(trendRows([{ date: "2026-10-05", total: 4 }, { date: "2026-10-06", total: "x" }], dayLabel), [
    { label: "10/5", value: 4 },
    { label: "10/6", value: 0 },
  ]);
  assert.equal(hasFigureData([{ value: 0 }, { value: 0 }]), false, "all zero: no figure");
  assert.equal(hasFigureData([{ value: 3 }]), true);
  assert.equal(hasFigureData([{ value: 3 }], 2), false, "a line needs at least two points");
  assert.equal(hasFigureData(undefined), false);
});

const art = (i, over = {}) => ({ url_hash: String(i).padStart(16, "0"), title: `記事${i}のタイトル`, url: `https://example.com/${i}`, platform: "zenn", summary: "あ".repeat(60), ...over });
const ai = (over = {}) => ({ title_ja: null, what: "概要です", use: "分かることです", apply: "試せそうです", term: null, term_meaning: null, source: "ai", ...over });
const program = (over = {}) =>
  buildRadioProgram({
    date: "2026-10-21",
    hour: 7,
    total: 9,
    highlights: [art(1), art(2), art(3)],
    lanes: [{ id: "game_dev_tech", label: "Game-Dev-Tech", count: 5, items: [art(4), art(5), art(6)], sources: [{ platform: "zenn", count: 3 }] }],
    insights: { [art(1).url_hash]: ai({ term: "用語", term_meaning: "説明です" }) },
    ...over,
  });

test("every corner is made of parts; the corner text is exactly the parts joined (the radio text is unchanged)", () => {
  for (const c of program().corners) {
    assert.ok(c.parts.length >= 1);
    assert.equal(c.text, c.parts.map((p) => p.text).join(""));
    assert.ok(c.parts.every((p) => p.slide && p.slide.kind && typeof p.speech === "string"));
  }
});

test("slides: opening has the total and per-category counts; item slides carry the explanation, the source and the original link", () => {
  const p = program();
  const open = p.corners[0].parts[0].slide;
  assert.equal(open.kind, "open");
  assert.equal(open.total, 9);
  assert.deepEqual(open.categories, [{ id: "game_dev_tech", label: "Game-Dev-Tech", count: 5 }]);
  const headlines = p.corners.find((c) => c.id === "headlines");
  assert.equal(headlines.parts[0].slide.kind, "corner");
  const item = headlines.parts[1].slide;
  assert.equal(item.kind, "item");
  assert.deepEqual([item.n, item.of], [1, 3]);
  assert.equal(item.heading, "記事1のタイトル");
  assert.equal(item.what, "概要です");
  assert.equal(item.use, "分かることです");
  assert.deepEqual(item.term, { term: "用語", meaning: "説明です" });
  assert.equal(item.ai, true);
  assert.equal(item.url, "https://example.com/1");
  assert.equal(item.source, "zenn");
});

test("slides: items without an AI insight show the first sentence of the summary and are not marked as AI", () => {
  const p = program({ insights: {}, highlights: [art(1, { summary: "最初の文です。二つ目です。" })] });
  const item = p.corners.find((c) => c.id === "headlines").parts[1].slide;
  assert.equal(item.ai, false);
  assert.equal(item.what, "最初の文です。");
  assert.equal(item.use, "");
  assert.equal(item.term, null);
});

test("slides: category corner carries the lane's source counts; glossary and recap carry their data; the ending closes", () => {
  const p = program();
  const cat = p.corners.find((c) => c.id === "game_dev_tech");
  assert.deepEqual(cat.parts[0].slide.sources, [{ platform: "zenn", count: 3 }]);
  assert.ok(cat.parts.slice(1).some((x) => x.slide.kind === "item"));
  assert.deepEqual(p.corners.find((c) => c.id === "glossary").parts[0].slide.terms, [{ term: "用語", meaning: "説明です" }]);
  assert.equal(p.corners.find((c) => c.id === "recap").parts[0].slide.titles.length, 3);
  assert.equal(p.corners.at(-1).parts[0].slide.kind, "close");
});
