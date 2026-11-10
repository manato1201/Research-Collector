// Cloudflare Access(複数人)と、利用者ごとのボード・ピン・設定(migration 0008。QUALITY_UPLIFT §1.8 の A6)の回帰テスト。
// D1 は node:sqlite の実 SQL(migrations を順に適用)。Access の公開鍵(JWKS)は、テストで作った RSA 鍵を fetch の差し替えで返す。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import {
  normalizeTeamDomain,
  parseEmailList,
  verifyAccessJwt,
} from "../src/auth.js";

const MIG = new URL("../migrations/", import.meta.url);
const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-abc123";
const HOST = "https://rb.example";
const H1 = "a".repeat(16);
const H2 = "b".repeat(16);

// ---- D1(実 SQL)。node:sqlite は FTS5 が無いので、全文検索の部分(0004)だけ取り除いて適用する
function migrate(db, upTo = Infinity) {
  const files = readdirSync(MIG)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const f of files) {
    if (Number(f.slice(0, 4)) > upTo) break;
    let sql = readFileSync(new URL(f, MIG), "utf8");
    sql = sql
      .replace(/CREATE VIRTUAL TABLE[\s\S]*?\);\s*/g, "")
      .replace(/CREATE TRIGGER[\s\S]*?END;\s*/g, "")
      .replace(/INSERT INTO articles_fts[^;]*;\s*/g, "");
    db.exec(sql);
  }
}
function d1(db) {
  const wrap = (sql) => ({
    args: [],
    bind(...a) {
      this.args = a;
      return this;
    },
    async run() {
      const r = db.prepare(sql).run(...this.args);
      return { meta: { changes: Number(r.changes) } };
    },
    async first() {
      return db.prepare(sql).get(...this.args) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...this.args) };
    },
    sql,
  });
  return {
    prepare: wrap,
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.all?.call(s));
      return out;
    },
  };
}
const newDb = (upTo) => {
  const db = new DatabaseSync(":memory:");
  migrate(db, upTo);
  return db;
};

// ---- Access の署名鍵と JWT
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const JWKS = {
  keys: [
    {
      kid: "k1",
      kty: "RSA",
      n: publicJwk.n,
      e: publicJwk.e,
      alg: "RS256",
      use: "sig",
    },
  ],
};

async function sign(
  claims = {},
  { kid = "k1", alg = "RS256", key = keyPair.privateKey } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    email: "alice@example.com",
    aud: [AUD],
    iss: `https://${TEAM}`,
    iat: now,
    exp: now + 300,
    ...claims,
  };
  const head = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  if (alg === "none") return `${head}.${body}.`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64u(sig)}`;
}

let realFetch;
let jwksFetches = 0;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) {
      jwksFetches++;
      return new Response(JSON.stringify(JWKS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const baseEnv = (db, extra = {}) => ({
  DB: d1(db),
  INGEST_TOKEN: "machine-token",
  CF_ACCESS_TEAM_DOMAIN: `https://${TEAM}/`,
  CF_ACCESS_AUD: AUD,
  ACCESS_ALLOWED_EMAILS: "Alice@example.com, bob@example.com",
  ...extra,
});

async function call(
  env,
  method,
  path,
  { jwt, body, origin = HOST, bearer, cookie } = {},
) {
  const headers = {};
  if (jwt) headers["cf-access-jwt-assertion"] = jwt;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  if (method !== "GET" && origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(
    new Request(`${HOST}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ------------------------------------------------------------------ JWT の検証(純粋関数)
test("helpers: team domain and email list are normalised", () => {
  assert.equal(
    normalizeTeamDomain(" https://a.cloudflareaccess.com// "),
    "a.cloudflareaccess.com",
  );
  assert.deepEqual(parseEmailList("A@x.com, b@y.com,,"), [
    "a@x.com",
    "b@y.com",
  ]);
});

test("verifyAccessJwt: accepts a good token, rejects every kind of bad one", async () => {
  const opts = { teamDomain: TEAM, aud: AUD, jwks: JWKS };
  assert.equal(
    (await verifyAccessJwt(await sign(), opts)).email,
    "alice@example.com",
  );
  assert.equal(
    (await verifyAccessJwt(await sign({ aud: AUD }), opts)).email,
    "alice@example.com",
    "aud as a string",
  );

  assert.equal(
    await verifyAccessJwt(await sign({ aud: ["other"] }), opts),
    null,
    "wrong audience",
  );
  assert.equal(
    await verifyAccessJwt(await sign({ iss: "https://evil.example" }), opts),
    null,
    "wrong issuer",
  );
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(
    await verifyAccessJwt(await sign({ exp: past }), opts),
    null,
    "expired",
  );
  assert.equal(
    await verifyAccessJwt(
      await sign({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
      opts,
    ),
    null,
    "not yet valid",
  );
  assert.equal(
    await verifyAccessJwt(await sign({}, { kid: "unknown" }), opts),
    null,
    "unknown kid",
  );
  assert.equal(
    await verifyAccessJwt(await sign({}, { alg: "none" }), opts),
    null,
    "alg none",
  );
  assert.equal(
    await verifyAccessJwt(await sign({}, { alg: "HS256" }), opts),
    null,
    "HS256 (never accepted)",
  );

  const good = await sign();
  const [h, , s] = good.split(".");
  const forged = `${h}.${b64u(JSON.stringify({ email: "mallory@example.com", aud: [AUD], iss: `https://${TEAM}`, exp: 9999999999 }))}.${s}`;
  assert.equal(
    await verifyAccessJwt(forged, opts),
    null,
    "payload swapped, signature kept",
  );

  const other = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  assert.equal(
    await verifyAccessJwt(await sign({}, { key: other.privateKey }), opts),
    null,
    "signed by another key",
  );
  assert.equal(await verifyAccessJwt("not-a-jwt", opts), null);
  assert.equal(await verifyAccessJwt(undefined, opts), null);
});

// ------------------------------------------------------------------ 認証と許可
test("access: listed email is let in, unlisted is 403, bad tokens are 401", async () => {
  const env = baseEnv(newDb());
  assert.equal(
    (await call(env, "GET", "/api/board", { jwt: await sign() })).status,
    200,
  );
  assert.equal(
    (
      await call(env, "GET", "/api/board", {
        jwt: await sign({ email: "ALICE@example.com" }),
      })
    ).status,
    200,
    "case-insensitive",
  );
  assert.equal(
    (
      await call(env, "GET", "/api/board", {
        jwt: await sign({ email: "mallory@example.com" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(env, "GET", "/api/board", {
        jwt: await sign({ email: undefined }),
      })
    ).status,
    403,
    "no email claim",
  );
  assert.equal(
    (
      await call(env, "GET", "/api/board", {
        jwt: await sign({ aud: ["other"] }),
      })
    ).status,
    401,
  );
  assert.equal(
    (await call(env, "GET", "/api/board")).status,
    401,
    "no credentials at all",
  );
});

test("access: with no ACCESS_ALLOWED_EMAILS nobody gets in (fail closed)", async () => {
  const env = baseEnv(newDb(), { ACCESS_ALLOWED_EMAILS: "" });
  assert.equal(
    (await call(env, "GET", "/api/board", { jwt: await sign() })).status,
    403,
  );
});

test("access: an invalid Access token does not fall back to the cookie session", async () => {
  const env = baseEnv(newDb(), { VIEW_PASSWORD: "p".repeat(24) });
  const r = await call(env, "GET", "/api/board", {
    jwt: await sign({ aud: ["other"] }),
    cookie: "rb_session=whatever",
  });
  assert.equal(r.status, 401);
});

test("access: the header is ignored when Access is not configured", async () => {
  const env = baseEnv(newDb(), {
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
  });
  assert.equal(
    (await call(env, "GET", "/api/board", { jwt: await sign() })).status,
    401,
  );
});

test("access: writes need a same-origin Origin (the Access cookie is sent by the browser on its own)", async () => {
  const env = baseEnv(newDb());
  const jwt = await sign();
  const put = (origin) =>
    call(env, "PUT", `/api/board/${H1}`, {
      jwt,
      body: { state: "reading", note: "" },
      origin,
    });
  assert.equal((await put(null)).status, 403);
  assert.equal((await put("https://evil.example")).status, 403);
  assert.equal((await put(HOST)).status, 200);
});

test("access: machine-only endpoints stay Bearer-only", async () => {
  const env = baseEnv(newDb());
  const jwt = await sign();
  assert.equal(
    (await call(env, "GET", "/api/export?table=board", { jwt })).status,
    401,
  );
  assert.equal(
    (await call(env, "POST", "/api/enrich", { jwt, body: {} })).status,
    401,
  );
  assert.equal(
    (await call(env, "POST", "/api/ingest", { jwt, body: {} })).status,
    401,
  );
  assert.equal(
    (
      await call(env, "GET", "/api/export?table=board", {
        bearer: "machine-token",
      })
    ).status,
    200,
  );
});

test("session endpoint tells who is in (and refuses an unlisted Access user)", async () => {
  const env = baseEnv(newDb());
  const ok = await call(env, "GET", "/api/session", { jwt: await sign() });
  assert.deepEqual(
    [ok.json.authenticated, ok.json.via, ok.json.email, ok.json.access_enabled],
    [true, "access", "alice@example.com", true],
  );
  assert.equal(
    (
      await call(env, "GET", "/api/session", {
        jwt: await sign({ email: "x@y.com" }),
      })
    ).status,
    403,
  );
  const anon = await call(env, "GET", "/api/session");
  assert.deepEqual([anon.json.authenticated, anon.json.via], [false, null]);
});

test("JWKS is cached, and a bad token cannot force a refetch every time", async () => {
  const env = baseEnv(newDb());
  await call(env, "GET", "/api/board", { jwt: await sign() });
  const before = jwksFetches;
  for (let i = 0; i < 5; i++)
    await call(env, "GET", "/api/board", {
      jwt: await sign({ aud: ["other"] }),
    });
  await call(env, "GET", "/api/board", { jwt: await sign() });
  assert.ok(
    jwksFetches - before <= 1,
    `refetched ${jwksFetches - before} times`,
  );
});

// ------------------------------------------------------------------ 利用者ごとのデータ
const items = (r) => r.json.items.map((i) => `${i.url_hash}:${i.state ?? ""}`);

test("board: each person has their own; the machine/password owner ('') is separate too", async () => {
  const env = baseEnv(newDb());
  const alice = await sign({ email: "alice@example.com" });
  const bob = await sign({ email: "bob@example.com" });

  await call(env, "PUT", `/api/board/${H1}`, {
    jwt: alice,
    body: { state: "reading", note: "alice's" },
  });
  await call(env, "PUT", `/api/board/${H1}`, {
    jwt: bob,
    body: { state: "hold", note: "bob's" },
  });
  await call(env, "PUT", `/api/board/${H2}`, {
    jwt: alice,
    body: { state: "try", note: "" },
  });

  const a = await call(env, "GET", "/api/board", { jwt: alice });
  const b = await call(env, "GET", "/api/board", { jwt: bob });
  assert.deepEqual(items(a).sort(), [`${H1}:reading`, `${H2}:try`]);
  assert.deepEqual(items(b), [`${H1}:hold`]);
  assert.equal(a.json.items.find((i) => i.url_hash === H1).note, "alice's");
  assert.deepEqual(
    (await call(env, "GET", "/api/board", { bearer: "machine-token" })).json
      .items,
    [],
    "owner '' sees neither",
  );

  // 片方の削除・一括操作が、もう片方に及ばない
  await call(env, "DELETE", `/api/board/${H1}`, { jwt: bob });
  assert.deepEqual(
    items(await call(env, "GET", "/api/board", { jwt: alice })).sort(),
    [`${H1}:reading`, `${H2}:try`],
  );
  await call(env, "POST", "/api/board/bulk", {
    jwt: bob,
    body: { hashes: [H1, H2], state: "read" },
  });
  assert.deepEqual(
    items(await call(env, "GET", "/api/board", { jwt: alice })).sort(),
    [`${H1}:reading`, `${H2}:try`],
  );
  assert.deepEqual(
    items(await call(env, "GET", "/api/board", { jwt: bob })).sort(),
    [`${H1}:read`, `${H2}:read`],
  );
  await call(env, "POST", "/api/board/bulk", {
    jwt: bob,
    body: { hashes: [H1], state: "unread" },
  });
  assert.deepEqual(items(await call(env, "GET", "/api/board", { jwt: bob })), [
    `${H2}:read`,
  ]);
  assert.equal(
    items(await call(env, "GET", "/api/board", { jwt: alice })).length,
    2,
  );
});

test("board import only touches the importer's own board", async () => {
  const env = baseEnv(newDb());
  const alice = await sign({ email: "alice@example.com" });
  const bob = await sign({ email: "bob@example.com" });
  await call(env, "PUT", `/api/board/${H1}`, {
    jwt: alice,
    body: { state: "reading", note: "keep" },
  });
  const r = await call(env, "POST", "/api/board/import", {
    jwt: bob,
    body: {
      overwrite: true,
      items: [{ url_hash: H1, state: "hold", note: "bob" }],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 1, "for bob it is new");
  const a = await call(env, "GET", "/api/board", { jwt: alice });
  assert.equal(a.json.items[0].state, "reading");
  assert.equal(a.json.items[0].note, "keep");
});

test("marks and prefs are per person", async () => {
  const env = baseEnv(newDb());
  const alice = await sign({ email: "alice@example.com" });
  const bob = await sign({ email: "bob@example.com" });

  await call(env, "PUT", `/api/marks/${H1}`, {
    jwt: alice,
    body: { pinned: true },
  });
  assert.equal(
    (await call(env, "GET", "/api/marks", { jwt: alice })).json.items.length,
    1,
  );
  assert.equal(
    (await call(env, "GET", "/api/marks", { jwt: bob })).json.items.length,
    0,
  );
  await call(env, "DELETE", `/api/marks/${H1}`, { jwt: bob });
  assert.equal(
    (await call(env, "GET", "/api/marks", { jwt: alice })).json.items.length,
    1,
    "bob's delete does not touch alice's pin",
  );

  await call(env, "PUT", "/api/prefs/watchwords", {
    jwt: alice,
    body: { value: ["GPU"] },
  });
  assert.deepEqual(
    (await call(env, "GET", "/api/prefs", { jwt: alice })).json.watchwords,
    ["GPU"],
  );
  assert.deepEqual(
    (await call(env, "GET", "/api/prefs", { jwt: bob })).json.watchwords,
    [],
  );
  await call(env, "PUT", "/api/prefs/watchwords", {
    jwt: bob,
    body: { value: ["Rust"] },
  });
  assert.deepEqual(
    (await call(env, "GET", "/api/prefs", { jwt: alice })).json.watchwords,
    ["GPU"],
    "bob's setting does not overwrite alice's",
  );
  assert.deepEqual(
    (await call(env, "GET", "/api/prefs", { bearer: "machine-token" })).json
      .watchwords,
    [],
  );
});

test("tidy (unread list) uses each person's own board and marks", async () => {
  const db = newDb();
  const nowIso =
    new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 19) + "Z";
  for (const h of [H1, H2]) {
    db.prepare(
      "INSERT INTO articles (url_hash, url, title, source_type, platform, categories, status, collected_at, updated_at) VALUES (?, ?, ?, 'rss', 'x', '[]', 'added', ?, ?)",
    ).run(h, `https://example.com/${h}`, `t${h}`, nowIso, nowIso);
  }
  const env = baseEnv(db);
  const alice = await sign({ email: "alice@example.com" });
  const bob = await sign({ email: "bob@example.com" });
  const unread = async (jwt) =>
    (await call(env, "GET", "/api/tidy?days=7&limit=10", { jwt })).json.unread;

  assert.equal(await unread(alice), 2);
  await call(env, "PUT", `/api/board/${H1}`, {
    jwt: alice,
    body: { state: "read", note: "" },
  });
  await call(env, "PUT", `/api/marks/${H2}`, {
    jwt: alice,
    body: { pinned: true },
  });
  assert.equal(await unread(alice), 0, "alice has handled both");
  assert.equal(await unread(bob), 2, "bob has handled neither");
});

test("READ_REQUIRES_TOKEN=false: a valid Access token still picks the owner, otherwise it is ''", async () => {
  const env = baseEnv(newDb(), { READ_REQUIRES_TOKEN: "false" });
  const alice = await sign({ email: "alice@example.com" });
  await call(env, "PUT", `/api/board/${H1}`, {
    jwt: alice,
    body: { state: "try", note: "" },
  });
  assert.equal(
    (await call(env, "GET", "/api/board", { jwt: alice })).json.items.length,
    1,
  );
  assert.equal(
    (await call(env, "GET", "/api/board")).json.items.length,
    0,
    "no token = the legacy owner, not alice",
  );
  assert.equal(
    (
      await call(env, "GET", "/api/board", {
        jwt: await sign({ aud: ["other"] }),
      })
    ).json.items.length,
    0,
  );
});

test("legacy behaviour is unchanged: Bearer and the password session still work, as owner ''", async () => {
  const env = baseEnv(newDb(), {
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
  });
  await call(env, "PUT", `/api/board/${H1}`, {
    bearer: "machine-token",
    body: { state: "reading", note: "" },
  });
  assert.equal(
    (await call(env, "GET", "/api/board", { bearer: "machine-token" })).json
      .items.length,
    1,
  );
});

// ------------------------------------------------------------------ migration 0008
test("migration 0008 keeps existing rows (as owner '') and enforces one row per (owner, key)", () => {
  const db = newDb(7);
  db.prepare(
    "INSERT INTO board (url_hash, state, note, updated_at) VALUES (?, 'reading', 'n', 't')",
  ).run(H1);
  db.prepare(
    "INSERT INTO marks (url_hash, pinned, remind_on, updated_at) VALUES (?, 1, '2026-12-01', 't')",
  ).run(H1);
  db.prepare(
    "INSERT INTO prefs (key, value, updated_at) VALUES ('watchwords', '[\"x\"]', 't')",
  ).run();

  db.exec(readFileSync(new URL("0008_owner.sql", MIG), "utf8"));

  assert.deepEqual(
    { ...db.prepare("SELECT owner, url_hash, state, note FROM board").get() },
    { owner: "", url_hash: H1, state: "reading", note: "n" },
  );
  assert.deepEqual(
    { ...db.prepare("SELECT owner, pinned, remind_on FROM marks").get() },
    { owner: "", pinned: 1, remind_on: "2026-12-01" },
  );
  assert.deepEqual(
    { ...db.prepare("SELECT owner, key, value FROM prefs").get() },
    { owner: "", key: "watchwords", value: '["x"]' },
  );
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO board (owner, url_hash, state, note, updated_at) VALUES ('', ?, 'hold', '', 't')",
      )
      .run(H1),
  );
  db.prepare(
    "INSERT INTO board (owner, url_hash, state, note, updated_at) VALUES ('a@x.com', ?, 'hold', '', 't')",
  ).run(H1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM board").get().c, 2);
});
