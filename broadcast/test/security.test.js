// セキュリティの点検(X2)の、回帰テスト: ログインの試行制限・危険な DOM 操作が無いこと・CSP
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_SEC, recordFailure, throttleKey, throttleState } from "../src/throttle.js";
import worker from "../src/index.js";

test("throttle: locks after the maximum failures inside the window, and unlocks when the window ends", () => {
  let rec = null;
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
    rec = recordFailure(rec, 1000 + i);
    assert.equal(throttleState(rec, 1000 + i).locked, false);
  }
  rec = recordFailure(rec, 1100);
  const st = throttleState(rec, 1100);
  assert.equal(st.locked, true);
  assert.equal(st.retryAfter, 1000 + LOGIN_WINDOW_SEC - 1100);
  assert.equal(throttleState(rec, 1000 + LOGIN_WINDOW_SEC).locked, false, "unlocked once the window has passed");
  assert.deepEqual(recordFailure(rec, 1000 + LOGIN_WINDOW_SEC + 5), { n: 1, t0: 1000 + LOGIN_WINDOW_SEC + 5 }, "a new window starts counting again");
});

test("throttle: junk records are ignored; keys are hashed, stable and per IP", async () => {
  assert.equal(throttleState(null, 1).locked, false);
  assert.equal(throttleState({ n: "x", t0: "y" }, 1).locked, false);
  const a = await throttleKey("203.0.113.9");
  assert.match(a, /^lf:[0-9a-f]{16}$/);
  assert.equal(a, await throttleKey("203.0.113.9"));
  assert.notEqual(a, await throttleKey("203.0.113.10"));
  assert.ok(!a.includes("203"), "the raw IP is never stored");
});

// ログインの経路(D1 は、メモリ上の小さな偽物)
const fakeDb = () => {
  const meta = new Map();
  return {
    meta,
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => (/FROM meta WHERE key/.test(sql) && meta.has(args[0]) ? { value: meta.get(args[0]) } : null),
          run: async () => {
            if (/INSERT INTO meta/.test(sql)) meta.set(args[0], args[1]);
            if (/DELETE FROM meta WHERE key = \?/.test(sql)) meta.delete(args[0]);
            return {};
          },
        }),
      };
    },
  };
};
const login = (env, password, ip = "203.0.113.9") =>
  worker.fetch(
    new Request("https://x.example/api/login", {
      method: "POST",
      headers: { origin: "https://x.example", "cf-connecting-ip": ip, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    env,
  );

test("login: after repeated failures the IP is refused with 429 (even with the right password); other IPs and a reset are unaffected", async () => {
  const env = { VIEW_PASSWORD: "correct-horse-battery", INGEST_TOKEN: "t".repeat(32), DB: fakeDb() };
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) assert.equal((await login(env, "wrong")).status, 401);
  const locked = await login(env, "correct-horse-battery");
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.equal((await login(env, "correct-horse-battery", "198.51.100.7")).status, 200, "another IP can log in");
  env.DB.meta.clear();
  assert.equal((await login(env, "correct-horse-battery")).status, 200);
}, { timeout: 30000 });

test("login: a successful login clears the failure count", async () => {
  const env = { VIEW_PASSWORD: "correct-horse-battery", INGEST_TOKEN: "t".repeat(32), DB: fakeDb() };
  await login(env, "wrong");
  assert.equal(env.DB.meta.size, 1);
  assert.equal((await login(env, "correct-horse-battery")).status, 200);
  assert.equal(env.DB.meta.size, 0);
});

test("login: if the database is unavailable the throttle fails open (the password check still applies)", async () => {
  const broken = { prepare: () => { throw new Error("D1_ERROR: unavailable"); } };
  const env = { VIEW_PASSWORD: "correct-horse-battery", INGEST_TOKEN: "t".repeat(32), DB: broken };
  assert.equal((await login(env, "wrong")).status, 401);
  assert.equal((await login(env, "correct-horse-battery")).status, 200);
}, { timeout: 30000 });

test("logout from another origin is refused; from the same origin it works", async () => {
  const env = { VIEW_PASSWORD: "p", INGEST_TOKEN: "t".repeat(32), DB: fakeDb() };
  const send = (origin) =>
    worker.fetch(new Request("https://x.example/api/logout", { method: "POST", headers: origin ? { origin } : {} }), env);
  assert.equal((await send("https://evil.example")).status, 403);
  assert.equal((await send(null)).status, 403);
  assert.equal((await send("https://x.example")).status, 200);
});

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
