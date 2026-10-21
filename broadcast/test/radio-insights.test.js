// 解説つきのラジオ原稿・「今日のおすすめ」の選び方の単体テスト
import assert from "node:assert/strict";
import { test } from "node:test";

import { pickRecommendation, scoreCandidate } from "../public/recommend.js";
import { buildRadioProgram, recommendText } from "../public/radio-script.js";

const art = (i, over = {}) => ({
  url_hash: `${i}`.padStart(16, "0"),
  title: `記事${i}のタイトル`,
  summary: `記事${i}の要約です。` + "あ".repeat(40),
  platform: "zenn",
  ...over,
});
const ai = (what, use = "読むと、手順が分かります", apply = "案件で試せそうです") => ({ what, use, apply, source: "ai" });
const rule = (what) => ({ what, use: "u", apply: "a", source: "rule" });

const base = (over = {}) => ({
  date: "2026-10-14",
  hour: 7,
  total: 10,
  highlights: [art(1), art(2)],
  lanes: [{ id: "game_dev_tech", label: "Game-Dev-Tech", count: 5, items: [art(3), art(4), art(5), art(6)] }],
  ...over,
});

test("with an AI insight, the item is introduced as: title, what it is, what you can do", () => {
  const p = buildRadioProgram(base({ insights: { [art(1).url_hash]: ai("HDA の自動コンパイルを止められる機能です", "編集中の待ち時間を減らせます") } }));
  const h = p.corners.find((c) => c.id === "headlines").text;
  assert.ok(h.includes("1本目。記事1のタイトル。HDA の自動コンパイルを止められる機能です。編集中の待ち時間を減らせます。"), h);
});

test("without an insight, the first sentence of the summary is read (as before)", () => {
  const p = buildRadioProgram(base());
  const h = p.corners.find((c) => c.id === "headlines").text;
  assert.ok(h.includes("記事1のタイトル。記事1の要約です。") || h.includes("記事1のタイトル。"), h);
});

test("the source of an item without an AI insight is introduced once per program", () => {
  const sourceWhat = "Zenn の技術記事。個人の開発者による、実装や調査の記事です。";
  const insights = {
    [art(3).url_hash]: rule(sourceWhat),
    [art(4).url_hash]: rule(sourceWhat),
  };
  const p = buildRadioProgram(base({ insights }));
  const g = p.corners.find((c) => c.id === "game_dev_tech").text;
  assert.equal(g.split("ちなみに、").length - 1, 1, g);
  assert.ok(g.includes("Zenn の技術記事"));
});

test("a corner reads at most three items when insights are available", () => {
  const insights = Object.fromEntries([3, 4, 5, 6].map((i) => [art(i).url_hash, ai(`説明${i}`)]));
  const p = buildRadioProgram(base({ insights }));
  const g = p.corners.find((c) => c.id === "game_dev_tech").text;
  assert.ok(g.includes("記事5のタイトル") && !g.includes("記事6のタイトル"));
  assert.ok(g.includes("ほかにも、2件あります"));
});

test("the recommendation corner sits after the headlines and uses the ad-style structure", () => {
  const rec = { title: "記事9のタイトル", what: "PDG のスキャンを止められる機能です", use: "大きなシーンが速くなります", apply: "重いシーンで試せそうです", projects: ["卒論"] };
  const p = buildRadioProgram(base({ recommend: rec }));
  assert.deepEqual(p.corners.map((c) => c.id).slice(0, 4), ["open", "headlines", "recommend", "game_dev_tech"]);
  const r = p.corners.find((c) => c.id === "recommend");
  assert.equal(r.jingle, "corner");
  assert.ok(r.text.startsWith("ここで、今日のおすすめをご紹介します。"));
  assert.ok(r.text.includes("この記事を読むと、大きなシーンが速くなります。"));
  assert.ok(r.text.includes("たとえば、重いシーンで試せそうです。"));
  assert.ok(r.text.includes("卒論に関係しそうです。"));
});

test("recommendText never doubles the sentence end", () => {
  const t = recommendText({ title: "題名。", what: "機能です。", use: "役立ちます。", apply: "試せます。" });
  assert.ok(!t.includes("。。"), t);
});

test("pickRecommendation: watchwords and projects outrank everything; ties keep the earlier item", () => {
  const items = [
    art(1),
    art(2, { title: "RAG と Houdini の自動化" }),
    art(3),
  ];
  const pick = pickRecommendation(items, {
    projects: [{ name: "卒論", keywords: ["RAG"] }],
    insights: { [art(1).url_hash]: ai("x") },
  });
  assert.equal(pick.article.url_hash, art(2).url_hash);
  assert.deepEqual(pick.reasons, [{ kind: "project", name: "卒論" }]);

  const tie = pickRecommendation([art(7), art(8)], {});
  assert.equal(tie.article.url_hash, art(7).url_hash);
});

test("pickRecommendation: read, muted and low-confidence items are never picked", () => {
  const items = [art(1, { review: true }), art(2), art(3, { platform: "qiita" })];
  const pick = pickRecommendation(items, {
    isRead: (h) => h === art(2).url_hash,
    isMuted: (p) => p === "qiita",
  });
  assert.equal(pick, null);
});

test("scoreCandidate: AI insight and summary add points; the result is deterministic", () => {
  const a = art(1);
  const s0 = scoreCandidate(a, {}).score;
  const s1 = scoreCandidate(a, { insight: ai("x") }).score;
  assert.equal(s1 - s0, 3);
  assert.equal(scoreCandidate(a, { watchwords: ["記事1"] }).score - s0, 6);
});
