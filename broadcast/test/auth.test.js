// 比較と Origin 検査の単体テスト(node --test)。パスワードのセッションは廃止した
import assert from "node:assert/strict";
import { test } from "node:test";

import { sameOrigin, timingSafeEqualStrings } from "../src/auth.js";

test("timingSafeEqualStrings", async () => {
  assert.equal(await timingSafeEqualStrings("abc", "abc"), true);
  assert.equal(await timingSafeEqualStrings("abc", "abd"), false);
  assert.equal(await timingSafeEqualStrings("abc", "abcd"), false);
  assert.equal(await timingSafeEqualStrings("", ""), true);
});

test("sameOrigin: Origin must match the host (CSRF guard for Access-authenticated writes)", () => {
  const url = new URL("https://rb.example.workers.dev/api/board/x");
  const req = (origin) => ({ headers: new Headers(origin ? { origin } : {}) });
  assert.equal(sameOrigin(req("https://rb.example.workers.dev"), url), true);
  assert.equal(sameOrigin(req("https://evil.example"), url), false);
  assert.equal(sameOrigin(req(null), url), false);
  assert.equal(sameOrigin(req("not a url"), url), false);
});
