// 設定・検索・非表示の収集元・ボードの「既読」の検証(DOM・D1 に依存しない部分)
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOARD_STATES,
  buildArticleQuery,
  escapeLike,
  parseSearch,
  validateBoardInput,
  validatePref,
} from "../src/validate.js";

test("prefs: watchwords are trimmed, de-duplicated and capped", () => {
  const r = validatePref("watchwords", [" Houdini ", "Houdini", "PCG"]);
  assert.deepEqual(r, { ok: true, value: ["Houdini", "PCG"] });
  assert.equal(validatePref("watchwords", Array.from({ length: 11 }, (_, i) => `w${i}`)).error, "bad_watchwords");
  assert.equal(validatePref("watchwords", ["", "x"]).error, "bad_watchword");
  assert.equal(validatePref("watchwords", ["x".repeat(41)]).error, "bad_watchword");
  assert.equal(validatePref("watchwords", "Houdini").error, "bad_watchwords");
});

test("prefs: projects need a name and keywords", () => {
  const ok = validatePref("projects", [{ name: " 卒論 ", keywords: ["RAG", "MCP", "RAG"] }]);
  assert.deepEqual(ok, { ok: true, value: [{ name: "卒論", keywords: ["RAG", "MCP"] }] });
  assert.equal(validatePref("projects", [{ name: "", keywords: [] }]).error, "bad_project");
  assert.equal(validatePref("projects", [{ name: "x", keywords: "RAG" }]).error, "bad_project_keywords");
  assert.equal(validatePref("projects", Array.from({ length: 13 }, () => ({ name: "x", keywords: [] }))).error, "bad_projects");
});

test("prefs: muted sources and unknown keys", () => {
  assert.deepEqual(validatePref("muted_sources", ["huggingface_blog"]), { ok: true, value: ["huggingface_blog"] });
  assert.equal(validatePref("muted_sources", [1]).error, "bad_muted_source");
  assert.equal(validatePref("something_else", []).error, "unknown_pref");
});

test("search: 3+ character words use full-text search (AND), short words use LIKE", () => {
  const a = parseSearch("Houdini PCG");
  assert.equal(a.useFts, true);
  assert.equal(a.match, '"Houdini" "PCG"');
  assert.equal(parseSearch("AI").useFts, false);
  assert.equal(parseSearch("描画").useFts, false); // 2文字
  assert.equal(parseSearch("描画法").useFts, true);
});

test("search: quotes are escaped so user input cannot become an FTS operator", () => {
  const p = parseSearch('foo" OR "bar');
  assert.ok(p.ok);
  assert.ok(!p.match.includes('" OR "'), p.match);
  assert.equal(parseSearch("   ").error, "bad_query");
  assert.equal(parseSearch("x".repeat(61)).error, "bad_query");
});

test("search: LIKE wildcards are neutralized", () => {
  assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
});

test("article query: excluded platforms become a NOT IN clause", () => {
  const q = buildArticleQuery(new URLSearchParams("exclude_platforms=huggingface_blog, qiita"));
  assert.ok(q.ok);
  assert.match(q.where, /platform NOT IN \(\?,\?\)/);
  assert.deepEqual(q.params, ["huggingface_blog", "qiita"]);
  assert.equal(buildArticleQuery(new URLSearchParams(`exclude_platforms=${"x".repeat(41)}`)).error, "bad_exclude_platforms");
});

test("board: 'read' is a valid state", () => {
  assert.ok(BOARD_STATES.includes("read"));
  assert.deepEqual(validateBoardInput({ state: "read" }), { ok: true, state: "read", note: "" });
});
