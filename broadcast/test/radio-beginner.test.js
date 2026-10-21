// 初心者・聞き手向けの番組(日本語ベース): 見どころの先出し・カテゴリの紹介・日本語の見出し・用語ひとこと・おさらい
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRadioProgram, displayTitle, normalizeForSpeech, recommendText, fitTitle } from "../public/radio-script.js";

const art = (i, over = {}) => ({
  url_hash: String(i).padStart(16, "0"),
  title: `記事${i}のタイトル`,
  summary: "あ".repeat(60),
  platform: "zenn",
  ...over,
});
const ai = (over = {}) => ({
  title_ja: null,
  what: "ゲームの入力の仕組みをやさしく説明した話です",
  use: "操作がうまく動かない理由が分かります",
  apply: "メニュー画面の設計で試せそうです",
  term: null,
  term_meaning: null,
  source: "ai",
  ...over,
});

const base = (over = {}) => ({
  date: "2026-10-21",
  hour: 7,
  total: 9,
  highlights: [art(1), art(2), art(3)],
  lanes: [{ id: "game_dev_tech", label: "Game-Dev-Tech", count: 5, items: [art(4), art(5), art(6)] }],
  insights: {},
  ...over,
});
const corner = (p, id) => p.corners.find((c) => c.id === id);

test("the opening previews today's highlights in Japanese, so a new listener knows what is coming", () => {
  const p = buildRadioProgram(base());
  const o = corner(p, "open").text;
  assert.ok(o.includes("今日の注目は、「記事1のタイトル」。それから、「記事2のタイトル」。"), o);
  assert.ok(o.includes("やさしくご紹介する番組です"));
});

test("an English title is replaced by its Japanese headline (AI), and never read in English", () => {
  const en = art(1, { title: "NVIDIA Cosmos3-H-Dreams: Bringing Clinical Surgery to Life" });
  assert.equal(displayTitle(en, null), "");
  assert.equal(displayTitle(en, { title_ja: "NVIDIA Cosmos3: 臨床手術を生成シミュレーションで再現" }), "NVIDIA Cosmos3: 臨床手術を生成シミュレーションで再現");
  const p = buildRadioProgram(base({ highlights: [en], insights: { [en.url_hash]: ai({ title_ja: "臨床手術を生成シミュレーションで再現" }) } }));
  const h = corner(p, "headlines").text;
  assert.ok(h.includes("1本目。臨床手術を生成シミュレーションで再現。"), h);
  assert.ok(!h.includes("Cosmos3-H-Dreams"));
});

test("an English-only item with no Japanese at all is not read aloud and not announced as a nameless item", () => {
  const en = art(1, { title: "Quarterly build status", summary: "English only summary text here." });
  const p = buildRadioProgram(base({ highlights: [en] }));
  assert.equal(corner(p, "headlines"), undefined);
  assert.ok(!corner(p, "open").text.includes("それでは、まず注目のニュースから"));
  assert.ok(!p.corners.some((c) => c.text.includes("Quarterly") || c.text.includes("英語の記事です")));
});

test("a category whose items are all English-only is said to be mostly English, in one short sentence", () => {
  const en = (i) => art(i, { title: `Release note ${i}`, summary: "English only summary text here." });
  const p = buildRadioProgram(base({ highlights: [], lanes: [{ id: "graphics_research", label: "G", count: 30, items: [en(1), en(2), en(3)] }] }));
  const c = corner(p, "graphics_research").text;
  assert.equal(c, "グラフィクスのコーナーです。新着は30件ですが、英語の記事が中心です。詳しくは、サイトでご覧ください。");
});

test("items that cannot be said in Japanese are skipped in favour of ones that can", () => {
  const en = art(1, { title: "Release note 1", summary: "English only summary text here." });
  const p = buildRadioProgram(base({ highlights: [], lanes: [{ id: "game_dev_tech", label: "G", count: 3, items: [en, art(2), art(3)] }] }));
  const g = corner(p, "game_dev_tech").text;
  assert.ok(g.includes("記事2のタイトル") && g.includes("記事3のタイトル") && !g.includes("Release note"));
});

test("the opening previews exactly what the headlines then read (AI-explained items come first)", () => {
  const plain = art(1);
  const explained = art(2);
  const p = buildRadioProgram(base({ highlights: [plain, explained], insights: { [explained.url_hash]: ai() } }));
  const o = corner(p, "open").text;
  assert.ok(o.includes("今日の注目は、「記事2のタイトル」。それから、「記事1のタイトル」。"), o);
  assert.ok(corner(p, "headlines").text.indexOf("記事2のタイトル") < corner(p, "headlines").text.indexOf("記事1のタイトル"));
});

test("fitTitle never cuts a title: it either fits or is left out of the list", () => {
  assert.equal(fitTitle("短い題名"), "短い題名");
  assert.equal(fitTitle("あ".repeat(35)), "");
  assert.equal(fitTitle("あ".repeat(34)), "あ".repeat(34));
  assert.equal(fitTitle(""), "");
});

test("each category corner says what kind of topics it covers", () => {
  const p = buildRadioProgram(base());
  const g = corner(p, "game_dev_tech").text;
  assert.ok(g.startsWith("ゲーム開発のコーナーです。ゲームづくりや、ゲームエンジンの技術に関する話題です。新着は5件。"), g);
});

test("a category without a defined introduction gets none (and no stray text)", () => {
  const p = buildRadioProgram(base({ lanes: [{ id: "extra_x", label: "Extra", count: 2, items: [art(4), art(5)] }] }));
  const c = corner(p, "extra_x").text;
  assert.ok(c.startsWith("Extraのコーナーです。新着は2件。"), c);
});

test("the glossary corner reads up to two terms from items that were actually read, and says they are AI-made", () => {
  const insights = {
    [art(1).url_hash]: ai({ term: "リバインド", term_meaning: "入力キーを自分で変更できる機能です" }),
    [art(2).url_hash]: ai({ term: "Prefab", term_meaning: "Unityで再利用できるオブジェクトのひな形です" }),
    [art(3).url_hash]: ai({ term: "単体テスト", term_meaning: "プログラムの一部を別々に確認するテストです" }),
    [art(6).url_hash]: ai({ term: "未読の用語", term_meaning: "読まれなかった記事の用語です" }),
  };
  const p = buildRadioProgram(base({ insights }));
  const g = corner(p, "glossary");
  assert.ok(g, "glossary corner exists");
  assert.ok(g.text.includes("AIがやさしくまとめました"));
  assert.ok(g.text.includes("まず、リバインド。入力キーを自分で変更できる機能です。"));
  assert.ok(g.text.includes("もうひとつ、Prefab。"));
  assert.ok(!g.text.includes("単体テスト") && !g.text.includes("未読の用語"));
});

test("no terms available -> no glossary corner", () => {
  assert.equal(corner(buildRadioProgram(base({ insights: { [art(1).url_hash]: ai() } })), "glossary"), undefined);
});

test("the recap names what was covered, in Japanese, and comes right before the ending", () => {
  const p = buildRadioProgram(base());
  const ids = p.corners.map((c) => c.id);
  assert.equal(ids.at(-2), "recap");
  assert.equal(ids.at(-1), "close");
  const r = corner(p, "recap").text;
  assert.ok(r.includes("今日のおさらいです。「記事1のタイトル」。「記事2のタイトル」。「記事3のタイトル」。以上を、お伝えしました。"), r);
  assert.ok(r.includes("サイトのボードに入れておくと"));
});

test("with fewer than two readable topics there is no recap", () => {
  const p = buildRadioProgram(base({ highlights: [art(1)], lanes: [] , total: 1}));
  assert.equal(corner(p, "recap"), undefined);
});

test("the source note for an item without an AI insight is spoken naturally, once", () => {
  const rule = { what: "Hugging Face ブログ。公開された AI モデルや手法の紹介記事です。", use: "u", apply: "a", source: "rule", title_ja: "モデルの紹介" };
  const a = art(1, { title: "Some model release", summary: "", platform: "huggingface_blog" });
  const b = art(2, { title: "Another model release", summary: "", platform: "huggingface_blog" });
  const p = buildRadioProgram(base({ highlights: [a, b], insights: { [a.url_hash]: rule, [b.url_hash]: { ...rule, title_ja: "別のモデル" } } }));
  const h = corner(p, "headlines").text;
  assert.equal(h.split("ちなみに、").length - 1, 1, h);
  assert.ok(h.includes("ちなみに、これは、Hugging Face ブログです。公開された AI モデルや手法の紹介記事です。"), h);
  assert.ok(h.includes("モデルの紹介") && h.includes("別のモデル"));
});

test("recommendText uses the Japanese headline for an English title", () => {
  const t = recommendText({ title: "Some English title", title_ja: "英語記事の日本語見出し", what: "機能の紹介です", use: "手順が分かります", apply: "試せそうです" });
  assert.ok(t.includes("英語記事の日本語見出し。"));
  assert.ok(!t.includes("Some English title"));
});

test("radio manners: no build numbers, no thousands separators, acronyms spelled out, no stray spaces", () => {
  assert.equal(normalizeForSpeech("Houdini 22.0.474のパラメータ修正"), "フーディーニのパラメータ修正");
  assert.equal(normalizeForSpeech("ルート数が50,000に増加"), "ルート数が50000に増加");
  assert.equal(normalizeForSpeech("XPUのEmbree処理"), "エックスピーユーのエンブリー処理");
  assert.equal(normalizeForSpeech("Cloudflare CLI でドキュメントを検索"), "クラウドフレアシーエルアイでドキュメントを検索");
  assert.equal(normalizeForSpeech("SILENT HILL"), "SILENT HILL"); // ふつうの英単語は、1字ずつ読まない
  assert.equal(normalizeForSpeech("UEFNと3D"), "ユーイーエフエヌとスリーディー");
});

test("the opening does not give a per-category breakdown (it would not add up to the total)", () => {
  const o = corner(buildRadioProgram(base({ total: 137 })), "open").text;
  assert.ok(o.includes("今日の新着は、全部で137件。その中から、気になる話題をお伝えします。"), o);
  assert.ok(!o.includes("内訳"));
});

test("a title that the explanation repeats is not read twice; category items omit the 'what you learn' sentence", () => {
  const a = art(1, { title: "Karmaレンダラーにオブジェクトレベルのパラメータが追加" });
  const b = art(2, { title: "別の話題のタイトル" });
  const insights = {
    [a.url_hash]: ai({ what: "Karmaレンダラーで、オブジェクトごとに設定できるようになりました", use: "調整の幅が広がることが分かります" }),
    [b.url_hash]: ai({ what: "別の話題の概要です", use: "別の話題で分かることです" }),
  };
  const p = buildRadioProgram(base({ highlights: [a], lanes: [{ id: "game_dev_tech", label: "G", count: 3, items: [b] }], insights }));
  const h = corner(p, "headlines").text;
  assert.ok(h.includes("1本目。Karmaレンダラーで、オブジェクトごとに設定できるようになりました。調整の幅が広がることが分かります。"), h);
  assert.ok(!h.includes("追加。Karma"));
  const g = corner(p, "game_dev_tech").text;
  assert.ok(g.includes("別の話題のタイトル。別の話題の概要です。") && !g.includes("別の話題で分かることです"), g);
});

test("spoken pace: a typical program stays within a few minutes and has no overly long sentence", () => {
  const items = (n, off) => Array.from({ length: n }, (_, i) => art(off + i));
  const insights = Object.fromEntries(items(20, 1).map((a) => [a.url_hash, ai({ what: "ゲームの入力の仕組みをやさしく説明した話です。専門用語も言い換えます", use: "操作が分かります" })]));
  const p = buildRadioProgram(base({
    highlights: items(3, 1),
    lanes: ["game_dev_tech", "graphics_research", "software_engineering"].map((id, k) => ({ id, label: id, count: 30, items: items(6, 4 + k * 6) })),
    insights,
  }));
  assert.ok(p.totalSeconds <= 300, `total ${p.totalSeconds}s`);
  const longest = Math.max(...p.corners.flatMap((c) => c.speech.split(/[。！？]/).map((x) => x.length)));
  assert.ok(longest <= 80, `longest sentence ${longest}`);
});
