// 取り込みの検証の単体テスト(node --test。Workers のランタイム不要)
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCategories, buildArticleQuery, validateArticle, validateIngest, validateReport, validateWatchItem } from "../src/validate.js";

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
  assert.equal(validateIngest({ schema: 1, articles: [] }).error, "nothing_to_ingest");
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

// ------------------------------------------------------------------ Phase 2: episode / failures / ボード
import { buildEpisodeQuery, isUrlHash, validateBoardInput, validateEpisode } from "../src/validate.js";

const episode = () => ({
  id: "daily:2026-10-11:game_dev_tech",
  kind: "daily",
  date: "2026-10-11",
  category: "game_dev_tech",
  headline: "Game-Dev-Tech: 新着2件",
  data: { count: 2, items: [{ title: "t", url: "https://example.com/1" }] },
});

test("episode: valid daily and weekly episodes are accepted", () => {
  const r = validateEpisode(episode());
  assert.equal(r.ok, true);
  assert.equal(r.value.category, "game_dev_tech");
  assert.equal(typeof r.value.json, "string");

  const all = { id: "daily:2026-10-11:all", kind: "daily", date: "2026-10-11", category: null, headline: "h", data: {} };
  assert.equal(validateEpisode(all).value.category, null);
  const w = { id: "weekly:2026-W41:all", kind: "weekly", date: "2026-W41", category: null, headline: "h", data: {} };
  assert.equal(validateEpisode(w).ok, true);
});

test("episode: id must agree with kind/date/category (idempotency key)", () => {
  assert.equal(validateEpisode({ ...episode(), kind: "weekly" }).error, "kind_mismatch");
  assert.equal(validateEpisode({ ...episode(), date: "2026-10-12" }).error, "date_mismatch");
  assert.equal(validateEpisode({ ...episode(), category: "graphics_research" }).error, "category_mismatch");
  assert.equal(validateEpisode({ ...episode(), id: "daily:2026-10-11:unknown_category" }).error, "bad_episode_id");
  assert.equal(validateEpisode({ ...episode(), id: "x" }).error, "bad_episode_id");
});

test("episode: size and shape limits", () => {
  assert.equal(validateEpisode({ ...episode(), data: [] }).error, "bad_data");
  assert.equal(validateEpisode({ ...episode(), headline: "" }).error, "bad_headline");
  const huge = { ...episode(), data: { blob: "x".repeat(210_000) } };
  assert.equal(validateEpisode(huge).error, "data_too_large");
});

test("ingest: episodes only (no articles) is accepted; empty body is not", () => {
  const ok = validateIngest({ schema: 1, articles: [], episodes: [episode()] });
  assert.equal(ok.ok, true);
  assert.equal(ok.episodes.length, 1);
  assert.equal(validateIngest({ schema: 1 }).error, "nothing_to_ingest");
  assert.equal(validateIngest({ schema: 1, articles: [], failures: [] }).ok, true);
});

test("ingest: invalid episodes are rejected individually; failures are trimmed", () => {
  const r = validateIngest({
    schema: 1,
    articles: [],
    episodes: [episode(), { id: "bad" }],
    failures: [{ source: "https://x/feed", error: "HTTP 404" }, { nope: 1 }, { source: "s".repeat(500) }],
  });
  assert.equal(r.episodes.length, 1);
  assert.deepEqual(r.rejectedEpisodes, [{ index: 1, error: "bad_episode_id" }]);
  assert.deepEqual(r.failures, [{ source: "https://x/feed", error: "HTTP 404" }]);
  const tooMany = validateIngest({ schema: 1, episodes: Array.from({ length: 21 }, episode) });
  assert.equal(tooMany.status, 413);
});

test("board: only known states; unread clears; note length", () => {
  assert.deepEqual(validateBoardInput({ state: "try" }), { ok: true, state: "try", note: "" });
  assert.equal(validateBoardInput({ state: "unread" }).ok, true);
  assert.equal(validateBoardInput({ state: "done" }).error, "bad_state");
  assert.equal(validateBoardInput({ state: "try", note: "x".repeat(201) }).error, "bad_note");
  assert.equal(validateBoardInput([]).error, "body_must_be_an_object");
  assert.equal(isUrlHash("0123456789abcdef"), true);
  assert.equal(isUrlHash("../../etc/passwd"), false);
});

test("episode query", () => {
  const q = buildEpisodeQuery(new URLSearchParams("kind=weekly&date=2026-W41&category=all"));
  assert.deepEqual(q, { ok: true, kind: "weekly", date: "2026-W41", category: "all" });
  assert.equal(buildEpisodeQuery(new URLSearchParams("")).date, "latest");
  assert.equal(buildEpisodeQuery(new URLSearchParams("kind=monthly")).error, "bad_kind");
  assert.equal(buildEpisodeQuery(new URLSearchParams("date=tomorrow")).error, "bad_date");
  assert.equal(buildEpisodeQuery(new URLSearchParams("category=nope")).error, "bad_category");
});

const report = () => ({
  id: "digest:2026-10-11",
  kind: "digest",
  date: "2026-10-11",
  title: "週次リサーチダイジェスト — 2026-W41",
  week: "2026-W41",
  generated_at: "2026-10-11T21:08:01Z",
  intro: "収集ノートブック: Game-Dev-Tech-2026-W41",
  sections: [
    { category: "game_dev_tech", heading: "ゲーム開発・エンジン技術", markdown: "要点: Unity の更新" },
    { category: "software_engineering", heading: "ソフトウェア工学・論文", markdown: "本文" },
  ],
});

test("report: valid digest is accepted", () => {
  const r = validateReport(report());
  assert.equal(r.ok, true);
  assert.equal(r.value.id, "digest:2026-10-11");
  assert.equal(JSON.parse(r.value.json).sections.length, 2);
});

test("report: id/date/kind mismatch and bad shapes are rejected", () => {
  assert.equal(validateReport({ ...report(), id: "digest:tomorrow" }).error, "bad_report_id");
  assert.equal(validateReport({ ...report(), date: "2026-10-12" }).error, "date_mismatch");
  assert.equal(validateReport({ ...report(), kind: "weekly" }).error, "bad_report_kind");
  assert.equal(validateReport({ ...report(), sections: [] }).error, "bad_sections");
  assert.equal(validateReport({ ...report(), week: "W41" }).error, "bad_week");
});

test("report: a category outside the allowlist is rejected (local-only fields never enter)", () => {
  const r = report();
  r.sections.push({ category: "unknown_category", heading: "x", markdown: "y" });
  assert.equal(validateReport(r).error, "category_not_allowed");
});

test("report: oversized body is rejected", () => {
  const r = report();
  r.sections = ["game_dev_tech", "graphics_research", "software_engineering"].map((category) => ({
    category,
    heading: "h",
    markdown: "x".repeat(110_000),
  }));
  assert.equal(validateReport(r).error, "report_too_large");
});

test("watch item: http(s) url and datetime required", () => {
  const w = { watch: "skills.sh", title: "a/b · c", url: "https://skills.sh/a/b/c", detected_at: "2026-10-11T21:00:00Z" };
  assert.equal(validateWatchItem(w).ok, true);
  assert.equal(validateWatchItem({ ...w, url: "javascript:alert(1)" }).error, "bad_url");
  assert.equal(validateWatchItem({ ...w, detected_at: "yesterday" }).error, "bad_detected_at");
});

test("ingest: reports-only and watch-only are accepted; empty is not", () => {
  const r = validateIngest({ schema: 1, reports: [report(), { id: "x" }] });
  assert.equal(r.ok, true);
  assert.equal(r.reports.length, 1);
  assert.deepEqual(r.rejectedReports, [{ index: 1, error: "bad_report_id" }]);
  const w = validateIngest({
    schema: 1,
    watch: [{ watch: "skills.sh", title: "t", url: "https://skills.sh/a/b/c", detected_at: "2026-10-11T21:00:00Z" }],
  });
  assert.equal(w.ok, true);
  assert.equal(w.watch.length, 1);
  assert.equal(validateIngest({ schema: 1, reports: [], watch: [] }).error, "nothing_to_ingest");
  assert.equal(validateIngest({ schema: 1, reports: Array.from({ length: 6 }, report) }).status, 413);
});

test("ingest: run.by_source keeps only short names with integer counts", () => {
  const r = validateIngest({
    schema: 1,
    articles: [good()],
    run: { collected: 96, by_source: { "Zenn/Qiita": 48, "": 1, bad: -1, frac: 1.5, ok: 0 } },
  });
  assert.deepEqual(r.run.by_source, { "Zenn/Qiita": 48, ok: 0 });
});

test("article query: since/until make a range; bad dates are rejected", () => {
  const q = buildArticleQuery(new URLSearchParams("since=2026-09-01&until=2026-09-30"));
  assert.equal(q.ok, true);
  assert.deepEqual(q.params, ["2026-09-01", "2026-09-30"]);
  assert.match(q.where, /<= \?/);
  assert.equal(buildArticleQuery(new URLSearchParams("until=last-month")).error, "bad_until");
});

test("extra categories: only well-formed ids, never overriding the base ones", () => {
  const r = resolveCategories('{"extra_one":"追加1","extra_two":"追加2","game_dev_tech":"x","Bad-ID":"y","ok":""}');
  assert.deepEqual(r.extra, { extra_one: "追加1", extra_two: "追加2" });
  assert.deepEqual(r.all, ["game_dev_tech", "graphics_research", "software_engineering", "extra_one", "extra_two"]);
  assert.deepEqual(resolveCategories(undefined).extra, {});
  assert.deepEqual(resolveCategories("not json").extra, {}); // 壊れた設定は基本の3つだけで動く
  assert.deepEqual(resolveCategories("[1,2]").extra, {});
});

test("extra categories: accepted only when configured", () => {
  const art = { ...good(), categories: ["extra_one"] };
  assert.equal(validateArticle(art).error, "category_not_allowed"); // 未設定なら従来どおり拒否
  assert.equal(validateArticle(art, resolveCategories('{"extra_one":"追加1"}').all).ok, true);
  const ep = { id: "daily:2026-10-11:extra_one", kind: "daily", date: "2026-10-11", category: "extra_one", headline: "h", data: {} };
  assert.equal(validateEpisode(ep).error, "bad_episode_id");
  assert.equal(validateEpisode(ep, resolveCategories('{"extra_one":"追加1"}').all).ok, true);
});

test("article query: collected_since and extra category filters", () => {
  const all = resolveCategories('{"extra_one":"追加1"}').all;
  assert.equal(buildArticleQuery(new URLSearchParams("category=extra_one")).error, "bad_category");
  assert.equal(buildArticleQuery(new URLSearchParams("category=extra_one"), all).ok, true);
  const q = buildArticleQuery(new URLSearchParams("collected_since=2026-10-01"));
  assert.equal(q.ok, true);
  assert.match(q.where, /substr\(collected_at, 1, 10\) >= \?/);
  assert.equal(buildArticleQuery(new URLSearchParams("collected_since=soon")).error, "bad_collected_since");
});
