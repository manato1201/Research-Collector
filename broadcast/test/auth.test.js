// セッションと比較の単体テスト(node --test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCookie, sameOrigin, sessionCookieHeader, signSession, timingSafeEqualStrings, verifySession } from "../src/auth.js";

const NOW = 1_800_000_000;

test("session: signed value verifies until it expires", async () => {
  const v = await signSession("pw", NOW, 100);
  assert.equal(await verifySession("pw", v, NOW), true);
  assert.equal(await verifySession("pw", v, NOW + 99), true);
  assert.equal(await verifySession("pw", v, NOW + 100), false); // 期限切れ
});

test("session: wrong secret, tampering and garbage are rejected", async () => {
  const v = await signSession("pw", NOW, 1000);
  assert.equal(await verifySession("other", v, NOW), false); // パスワード変更で全セッション失効
  const [exp, sig] = v.split(".");
  assert.equal(await verifySession("pw", `${Number(exp) + 5000}.${sig}`, NOW), false); // 期限の書き換え
  for (const bad of ["", "x", "123.abc", ".abc", "1800000100.", null, undefined, 42]) {
    assert.equal(await verifySession("pw", bad, NOW), false, String(bad));
  }
  assert.equal(await verifySession("", v, NOW), false);
});

test("timingSafeEqualStrings", async () => {
  assert.equal(await timingSafeEqualStrings("abc", "abc"), true);
  assert.equal(await timingSafeEqualStrings("abc", "abd"), false);
  assert.equal(await timingSafeEqualStrings("abc", "abcd"), false);
  assert.equal(await timingSafeEqualStrings("", ""), true);
});

test("cookie parsing and header", () => {
  assert.equal(parseCookie("a=1; rb_session=xyz; b=2", "rb_session"), "xyz");
  assert.equal(parseCookie("a=1", "rb_session"), null);
  assert.equal(parseCookie(null, "rb_session"), null);
  const h = sessionCookieHeader("v", 60);
  for (const part of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=60"]) assert.ok(h.includes(part), part);
  assert.ok(!sessionCookieHeader("v", 60, false).includes("Secure"));
});

test("sameOrigin: Origin must match the host (CSRF guard for cookie-authenticated writes)", () => {
  const url = new URL("https://rb.example.workers.dev/api/board/x");
  const req = (origin) => ({ headers: new Headers(origin ? { origin } : {}) });
  assert.equal(sameOrigin(req("https://rb.example.workers.dev"), url), true);
  assert.equal(sameOrigin(req("https://evil.example"), url), false);
  assert.equal(sameOrigin(req(null), url), false);
  assert.equal(sameOrigin(req("not a url"), url), false);
});
