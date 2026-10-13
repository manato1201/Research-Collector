// 読み上げの分割と、記事の並び順(order)の単体テスト
import assert from "node:assert/strict";
import { test } from "node:test";

import { splitChunks } from "../public/radio-script.js";
import { buildArticleQuery } from "../src/validate.js";

test("splitChunks: sentences are kept whole and merged up to the limit", () => {
  const out = splitChunks("一つ目です。二つ目です。三つ目です。", 12);
  assert.deepEqual(out, ["一つ目です。二つ目です。", "三つ目です。"]);
});

test("splitChunks: a long sentence is cut at a comma, never losing text", () => {
  const text = `${"あ".repeat(60)}、${"い".repeat(60)}、${"う".repeat(60)}。`;
  const out = splitChunks(text, 80);
  assert.ok(out.every((c) => c.length <= 80), out.map((c) => c.length).join(","));
  assert.equal(out.join(""), text);
});

test("splitChunks: a long sentence without commas is cut by length", () => {
  const out = splitChunks("あ".repeat(300), 100);
  assert.ok(out.length >= 3 && out.every((c) => c.length <= 100));
  assert.equal(out.join("").length, 300);
});

test("splitChunks: empty and whitespace input give no chunks", () => {
  assert.deepEqual(splitChunks(""), []);
  assert.deepEqual(splitChunks("   \n  "), []);
  assert.deepEqual(splitChunks(null), []);
});

test("splitChunks: works without regex lookbehind (older Safari)", () => {
  // 関数のソースに後読みが入っていないことを確かめる(構文エラーでアプリ全体が動かなくなるため)
  assert.ok(!splitChunks.toString().includes("(?<="));
});

test("article query: order is published by default, collected on request, anything else is rejected", () => {
  const def = buildArticleQuery(new URLSearchParams(""));
  assert.match(def.order, /COALESCE\(published/);
  const col = buildArticleQuery(new URLSearchParams("order=collected"));
  assert.equal(col.order, "collected_at DESC");
  assert.equal(buildArticleQuery(new URLSearchParams("order=title; DROP TABLE articles")).error, "bad_order");
});
