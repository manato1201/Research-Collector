// セキュリティの点検(X2)の、回帰テスト: 危険な DOM 操作が無いこと・CSP
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import worker from "../src/index.js";

// D1 は、メモリ上の小さな偽物
const fakeDb = () => ({ prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) });

test("API JSON responses carry X-Content-Type-Options: nosniff", async () => {
  const res = await worker.fetch(new Request("https://x.example/api/health"), { INGEST_TOKEN: "t".repeat(32), DB: fakeDb() });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("the site never uses HTML-injecting or code-evaluating DOM APIs (textContent only)", () => {
  const dir = new URL("../public/", import.meta.url);
  const bad = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function\s*\()/;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const hit = src.find((l) => bad.test(l));
    assert.equal(hit, undefined, `${f}: ${hit}`);
  }
});

test("CSP: same-origin scripts only, no inline or eval", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const csp = /Content-Security-Policy: (.+)/.exec(headers)[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp.replace("style-src 'self' https://fonts.googleapis.com", "")), csp);
  assert.match(csp, /frame-ancestors 'none'/);
});
