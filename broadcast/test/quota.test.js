// D1 の無料枠を超えたときは、500 ではなく原因の分かる 503 を返す
import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";

const env = (message) => ({
  INGEST_TOKEN: "t".repeat(32),
  DB: {
    prepare() {
      throw new Error(message);
    },
  },
});
const get = (e) =>
  worker.fetch(new Request("https://x.example/api/status", { headers: { authorization: `Bearer ${"t".repeat(32)}` } }), e);

test("D1 free-tier quota exhaustion -> 503 d1_quota_exceeded with retry-after", async () => {
  const res = await get(env("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "d1_quota_exceeded" });
  assert.equal(res.headers.get("retry-after"), "3600");
});

test("other database errors stay 500 internal_error", async () => {
  const res = await get(env("D1_ERROR: no such table: articles"));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal_error" });
});
