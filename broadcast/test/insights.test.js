// 解説(これは何か / 何ができるか / どう応用できるか)の、指示の組み立てと出力の検証の単体テスト
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMessages,
  extractText,
  fallbackInsight,
  hasBasis,
  parseInsight,
  relevantProjects,
  sourceInfo,
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
  assert.deepEqual(r, { what: "PDG のスキャンを止められます", use: "大きなシーンの速度を上げられます", apply: "重いシーンで試せそうです" });
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
