// 取り込みの検証の単体テスト(node --test。Workers のランタイム不要)
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildArticleQuery, validateArticle, validateIngest } from "../src/validate.js";

const good = () => ({
  url_hash: "0123456789abcdef",
  url: "https://example.com/a",
  title: "UnityのRenderGraphでメモリ帯域を削減する",
  source_type: "unity",
  platform: "zenn",
  categories: ["game_dev_tech", "graphics_research"],
  label: "graphics_research",
  keywords: ["rendergraph"],
  review: false,
  status: "added",
  published: "2026-10-10",
  collected_at: "2026-10-10T21:00:00Z",
  summary: "要約です。",
  summary_src: "feed",
});

test("valid article is accepted and normalized", () => {
  const r = validateArticle(good());
  assert.equal(r.ok, true);
  assert.equal(r.value.review, 0);
  assert.deepEqual(JSON.parse(r.value.categories), ["game_dev_tech", "graphics_research"]);
});

test("old-format row without summary fields is accepted (backward compatible)", () => {
  const a = good();
  delete a.summary;
  delete a.summary_src;
  const r = validateArticle(a);
  assert.equal(r.ok, true);
  assert.equal(r.value.summary, null);
});

test("a category outside the three is rejected (local-only fields must never be ingested)", () => {
  const a = good();
  a.categories = ["game_dev_tech", "some_local_only_category"];
  assert.deepEqual(validateArticle(a), { ok: false, error: "category_not_allowed" });
});

test("non-http(s) urls are rejected", () => {
  for (const url of ["javascript:alert(1)", "ftp://x.example/a", "data:text/html,hi"]) {
    const a = good();
    a.url = url;
    assert.equal(validateArticle(a).ok, false, url);
  }
  const b = good();
  b.merged_into = "javascript:evil()";
  assert.deepEqual(validateArticle(b), { ok: false, error: "bad_merged_into" });
});

test("x_post never stores a summary (no re-publishing of post bodies)", () => {
  const a = good();
  a.source_type = "x_post";
  a.categories = ["software_engineering"];
  const r = validateArticle(a);
  assert.equal(r.ok, true);
  assert.equal(r.value.summary, null);
  assert.equal(r.value.summary_src, null);
});

test("field limits", () => {
  const a = good();
  a.title = "x".repeat(501);
  assert.equal(validateArticle(a).ok, false);
  const b = good();
  b.url_hash = "NOT-A-HASH-VALUE!";
  assert.equal(validateArticle(b).ok, false);
  const c = good();
  c.collected_at = "2026-10-10";
  assert.equal(validateArticle(c).ok, false);
});

test("ingest: unsupported schema, empty and oversized batches", () => {
  assert.equal(validateIngest({ schema: 2, articles: [good()] }).error, "unsupported_schema");
  assert.equal(validateIngest({ schema: 1, articles: [] }).error, "articles_is_empty");
  const big = Array.from({ length: 201 }, () => good());
  const r = validateIngest({ schema: 1, articles: big });
  assert.equal(r.status, 413);
});

test("ingest: partial rejection is reported per index; in-request duplicates are rejected", () => {
  const bad = good();
  bad.url_hash = "zzzz";
  const dup = good();
  const r = validateIngest({ schema: 1, articles: [good(), bad, dup], run: { collected: 96, evil: { a: 1 }, "Bad Key": 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.rejected.map((x) => [x.index, x.error]), [[1, "bad_url_hash"], [2, "duplicate_in_request"]]);
  assert.deepEqual(r.run, { collected: 96 }); // オブジェクトや不正なキーは通さない
});

test("article query: filters and limits", () => {
  const q = buildArticleQuery(new URLSearchParams("category=game_dev_tech&status=added&since=2026-10-01&review=1&limit=20"));
  assert.equal(q.ok, true);
  assert.deepEqual(q.params, ["game_dev_tech", "added", "2026-10-01"]);
  assert.match(q.where, /json_each/);
  assert.equal(q.limit, 20);

  assert.equal(buildArticleQuery(new URLSearchParams("category=unknown_category")).error, "bad_category");
  assert.equal(buildArticleQuery(new URLSearchParams("limit=1000")).error, "bad_limit");
  assert.equal(buildArticleQuery(new URLSearchParams("since=yesterday")).error, "bad_since");
  // SQL インジェクション様の入力は、許可リスト・形式の検査で弾かれる(値は常に束縛される)
  assert.equal(buildArticleQuery(new URLSearchParams("category=' OR 1=1 --")).error, "bad_category");
});
