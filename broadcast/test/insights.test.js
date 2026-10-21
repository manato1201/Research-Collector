// 解説(これは何か / 何ができるか / どう応用できるか)の、指示の組み立てと出力の検証の単体テスト
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMessages,
  buildTitleMessages,
  extractText,
  fallbackInsight,
  hasBasis,
  INSIGHT_VERSION,
  parseInsight,
  parseTitle,
  relevantProjects,
  sourceInfo,
  titleIsFaithful,
} from "../src/insights.js";

const article = (over = {}) => ({
  title: "HDAs can now disable the scan for PDG networks",
  summary: "HDAs can now disable the scan for PDG networks by specifing a parameter. This can improve performance on large scenes.",
  platform: "sidefx_changelog",
  categories: ["game_dev_tech", "graphics_research"],
  published: "2026-10-12",
  ...over,
});

test("parseInsight: valid JSON is accepted and trimmed", () => {
  const r = parseInsight('{"what":"PDG のスキャンを止められます","use":"大きなシーンの速度を上げられます","apply":"重いシーンで試せそうです"}');
  assert.deepEqual(r, {
    title_ja: null,
    what: "PDG のスキャンを止められます",
    use: "大きなシーンの速度を上げられます",
    apply: "重いシーンで試せそうです",
    term: null,
    term_meaning: null,
  });
});

test("parseInsight: JSON inside prose or a code fence is found; think blocks are ignored", () => {
  const raw = '<think>候補 {"what": "x"} を検討</think>\n```json\n{"what":"機能の紹介です","use":"手順が分かります","apply":"案件で試せそうです"}\n```';
  const r = parseInsight(raw);
  assert.equal(r.what, "機能の紹介です");
});

test("parseInsight: rejects missing fields, non-Japanese output, and garbage", () => {
  assert.equal(parseInsight('{"what":"紹介です","use":"役に立ちます"}'), null);
  assert.equal(parseInsight('{"what":"An intro","use":"Helps you","apply":"Use it"}'), null);
  assert.equal(parseInsight("not json"), null);
  assert.equal(parseInsight(null), null);
  assert.equal(parseInsight("{broken"), null);
});

test("parseInsight: URLs are removed and long fields are capped", () => {
  const r = parseInsight(JSON.stringify({
    what: "詳細は https://example.com/x を参照してください",
    use: "あ".repeat(300),
    apply: "応用できそうです",
  }));
  assert.ok(!r.what.includes("http"));
  assert.ok(r.use.length <= 110);
  assert.ok(r.use.endsWith("…"));
});

test("relevantProjects: only projects whose keywords appear in the article", () => {
  const projects = [
    { name: "卒論", keywords: ["RAG", "MCP"] },
    { name: "ゲーム", keywords: ["Unity"] },
  ];
  const hit = relevantProjects(article({ title: "MCP server for Workers" }), projects);
  assert.deepEqual(hit.map((p) => p.name), ["卒論"]);
  assert.deepEqual(relevantProjects(article(), projects), []);
});

test("buildMessages: interests are passed only when relevant; otherwise 'なし'", () => {
  const projects = [{ name: "卒論", keywords: ["RAG"] }];
  const none = buildMessages(article(), { projects });
  assert.ok(none[1].content.includes('"読み手の関心": "なし"'));
  assert.ok(!none[1].content.includes("卒論"));
  const some = buildMessages(article({ title: "RAG with Houdini" }), { projects });
  assert.ok(some[1].content.includes("卒論"));
});

test("buildMessages: grounded-only rules and a no_think switch", () => {
  const m = buildMessages(article(), { noThink: true });
  assert.equal(m[0].role, "system");
  assert.ok(m[0].content.includes("題名・要約に書かれていないことを、事実として断定しない"));
  assert.ok(m[1].content.startsWith("/no_think\n"));
  assert.ok(!buildMessages(article())[1].content.startsWith("/no_think"));
});

test("hasBasis: a title-only article is not sent to the model", () => {
  assert.equal(hasBasis(article({ summary: null })), false);
  assert.equal(hasBasis(article({ summary: "短い" })), false);
  assert.equal(hasBasis(article()), true);
});

test("fallbackInsight and sourceInfo: known sources get their own text, unknown get a default", () => {
  assert.ok(sourceInfo("sidefx_changelog").name.includes("Houdini"));
  assert.equal(sourceInfo("nobody_knows").name, "収集した記事");
  const f = fallbackInsight({ platform: "arxiv", title: "x" });
  assert.ok(f.what.includes("arXiv") && f.use && f.apply);
});

test("extractText: handles the response shapes of different models", () => {
  assert.equal(extractText({ response: "a" }), "a");
  assert.equal(extractText({ choices: [{ message: { content: "b" } }] }), "b");
  assert.equal(extractText({ choices: [{ text: "c" }] }), "c");
  assert.equal(extractText("d"), "d");
  assert.equal(extractText({ choices: [{ message: { content: null } }] }), null);
  assert.equal(extractText(null), null);
});

test("parseInsight: beginner fields (Japanese title, term + meaning) are kept; a term without a meaning is dropped", () => {
  const base = { what: "機能の紹介です", use: "手順が分かります", apply: "案件で試せそうです" };
  const full = parseInsight(JSON.stringify({ ...base, title_ja: "# HDA のスキャンを止める", term: "PDG", term_meaning: "作業を自動で並べて実行する仕組みです" }));
  assert.equal(full.title_ja, "HDA のスキャンを止める"); // 先頭の見出し記号は落とす
  assert.equal(full.term, "PDG");
  assert.equal(full.term_meaning, "作業を自動で並べて実行する仕組みです");
  const half = parseInsight(JSON.stringify({ ...base, term: "PDG", term_meaning: "" }));
  assert.equal(half.term, null);
  assert.equal(half.term_meaning, null);
  assert.equal(parseInsight(JSON.stringify({ ...base, title_ja: "English only" })).title_ja, null);
});

test("buildMessages: asks for spoken, beginner-friendly Japanese and a Japanese title", () => {
  const sys = buildMessages(article())[0].content;
  assert.ok(sys.includes("初心者") && sys.includes("title_ja") && sys.includes("term_meaning") && sys.includes("話し言葉"));
  assert.ok(sys.includes("意味に自信が無い用語は"));
});

test("title-only mode: a translation request, and only a Japanese title is accepted", () => {
  const m = buildTitleMessages({ title: "NVIDIA Cosmos3: Bringing Clinical Surgery to Life" }, { noThink: true });
  assert.ok(m[0].content.includes("題名に無い内容を足さない"));
  assert.ok(m[1].content.startsWith("/no_think\n") && m[1].content.includes("Cosmos3"));
  assert.equal(parseTitle('{"title_ja":"NVIDIA Cosmos3: 臨床手術を生成シミュレーションで再現"}'), "NVIDIA Cosmos3: 臨床手術を生成シミュレーションで再現");
  assert.equal(parseTitle('{"title_ja":"Cosmos3 only"}'), null);
  assert.equal(parseTitle("not json"), null);
  assert.equal(INSIGHT_VERSION, 2);
});

test("titleIsFaithful: English words in the Japanese headline must exist in the original title", () => {
  const original = "SILENT HILL: Townfall delivers haunting psychological horror with UE5";
  assert.equal(titleIsFaithful("SILENT HILL: Townfall のホラー表現", original), true);
  assert.equal(titleIsFaithful("SILENT HIL: Townfall のホラー表現", original), false); // 綴りの崩れ
  assert.equal(titleIsFaithful("新しい機能の紹介", original), true); // 英字を含まない見出しは問題なし
  assert.equal(titleIsFaithful("ホラー表現と Lumen", original), false); // 元に無い語を足した
});
