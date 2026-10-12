// ResearchBroadcast — 取り込み・記事API・episode・ボード・ログイン。ResearchBroadcast_DESIGN.md §2〜§4
//
// 機械(GitHub Actions)から:  Authorization: Bearer <INGEST_TOKEN>
//   POST /api/ingest        記事・episode・失敗の状態を受け取り、D1 に upsert する(冪等)
// 人(ブラウザ)から:  Cookie(POST /api/login に VIEW_PASSWORD を送ると発行される)
//   POST /api/login | POST /api/logout | GET /api/session
// どちらでも:
//   GET  /api/articles      記事の一覧(category / status / since / review / limit / offset)
//   GET  /api/episodes      今日の放送・週次特集(kind / date=latest|日付 / category)
//   GET  /api/episodes/dates   episode のある日付の一覧
//   GET  /api/board         ボード(読む・試す・保留)
//   PUT  /api/board/{url_hash} | DELETE /api/board/{url_hash}
//   GET  /api/reports      週次レポート(ダイジェスト)の一覧 / GET /api/reports/{id} 本文
//   GET  /api/watch        配布サイトの新着(通知のみ)
//   GET  /api/status        件数(URL単位)・カテゴリ別・直近の取り込み・失敗した収集元
//   GET  /api/health        生存確認(認証なし。データは返さない)
// それ以外は静的アセット(public/。サイトの本体)。サイト自体にデータは入っていない。

import {
  parseCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sameOrigin,
  sessionCookieHeader,
  signSession,
  timingSafeEqualStrings,
  verifySession,
} from "./auth.js";
import {
  BOARD_STATES,
  buildArticleQuery,
  buildEpisodeQuery,
  isUrlHash,
  MAX_BODY_BYTES,
  validateBoardInput,
  validateIngest,
} from "./validate.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const BATCH_SIZE = 50;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(JSON.stringify({ message: "unhandled error", path: url.pathname, error: String(err?.message ?? err) }));
      return json({ error: "internal_error" }, 500);
    }
  },
};

const methodNotAllowed = (allow) => json({ error: "method_not_allowed" }, 405, { allow });

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // API 以外は静的アセット(サイト本体)。wrangler.jsonc の run_worker_first で通常はここに来ない
  if (!pathname.startsWith("/api/")) {
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "not_found" }, 404);
  }

  if (pathname === "/api/health") {
    return method === "GET" ? json({ ok: true }) : methodNotAllowed("GET");
  }

  // ---- ログイン(人)
  if (pathname === "/api/login") {
    return method === "POST" ? handleLogin(request, env, url) : methodNotAllowed("POST");
  }
  if (pathname === "/api/logout") {
    return method === "POST" ? handleLogout(url) : methodNotAllowed("POST");
  }
  if (pathname === "/api/session") {
    if (method !== "GET") return methodNotAllowed("GET");
    const who = await whoami(request, env);
    return json({ authenticated: who !== null, via: who, login_enabled: Boolean(env.VIEW_PASSWORD) });
  }

  // ---- 取り込み(機械。Bearer のみ)
  if (pathname === "/api/ingest") {
    if (method !== "POST") return methodNotAllowed("POST");
    const denied = await requireBearer(request, env);
    if (denied) return denied;
    return handleIngest(request, env);
  }

  // ---- 読み出し・ボード(Bearer か ログイン済みの Cookie)
  const board = /^\/api\/board(?:\/([^/]+))?$/.exec(pathname);
  if (board) {
    if (board[1] === undefined) {
      if (method !== "GET") return methodNotAllowed("GET");
      return withAuth(request, env, url, false, () => handleBoardList(env));
    }
    if (!["PUT", "DELETE"].includes(method)) return methodNotAllowed("PUT, DELETE");
    if (!isUrlHash(board[1])) return json({ error: "bad_url_hash" }, 400);
    return withAuth(request, env, url, true, () => handleBoardWrite(request, env, board[1], method));
  }

  const report = /^\/api\/reports\/([^/]+)$/.exec(pathname);
  if (report) {
    if (method !== "GET") return methodNotAllowed("GET");
    const id = decodeURIComponent(report[1]);
    return withAuth(request, env, url, false, () => handleReport(env, id));
  }

  const reads = {
    "/api/articles": () => handleArticles(url, env),
    "/api/episodes": () => handleEpisodes(url, env),
    "/api/episodes/dates": () => handleEpisodeDates(url, env),
    "/api/status": () => handleStatus(env),
    "/api/reports": () => handleReportList(url, env),
    "/api/watch": () => handleWatch(env),
  };
  if (reads[pathname]) {
    if (method !== "GET") return methodNotAllowed("GET");
    return withAuth(request, env, url, false, reads[pathname]);
  }

  return json({ error: "not_found" }, 404);
}

// ------------------------------------------------------------------ 認証

/** "bearer" | "session" | "open"(READ_REQUIRES_TOKEN=false)| null */
async function whoami(request, env) {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && env.INGEST_TOKEN && (await timingSafeEqualStrings(header.slice(7), env.INGEST_TOKEN))) {
    return "bearer";
  }
  const cookie = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (cookie && env.VIEW_PASSWORD && (await verifySession(env.VIEW_PASSWORD, cookie))) {
    return "session";
  }
  return null;
}

async function requireBearer(request, env) {
  if (!env.INGEST_TOKEN) {
    // トークン未設定のまま公開してしまう事故を防ぐ(未設定 = 全拒否)
    console.error(JSON.stringify({ message: "INGEST_TOKEN is not configured" }));
    return json({ error: "server_not_configured" }, 503);
  }
  if ((await whoami(request, env)) !== "bearer") {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  return null;
}

/**
 * 読み出し・ボード用の認証。mutating=true(書き込み)のとき、Cookie 認証なら Origin の一致も要る(CSRF 対策)。
 * READ_REQUIRES_TOKEN="false" は「Access などで全ホスト名を保護済み」と運用者が確認した場合のみ。
 */
async function withAuth(request, env, url, mutating, handler) {
  if (env.READ_REQUIRES_TOKEN === "false") return handler();

  if (!env.INGEST_TOKEN && !env.VIEW_PASSWORD) {
    console.error(JSON.stringify({ message: "neither INGEST_TOKEN nor VIEW_PASSWORD is configured" }));
    return json({ error: "server_not_configured" }, 503);
  }
  const who = await whoami(request, env);
  if (who === null) return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  if (mutating && who === "session" && !sameOrigin(request, url)) {
    return json({ error: "bad_origin" }, 403);
  }
  return handler();
}

async function handleLogin(request, env, url) {
  if (!env.VIEW_PASSWORD) return json({ error: "login_not_configured" }, 503);
  if (!sameOrigin(request, url)) return json({ error: "bad_origin" }, 403);

  const text = await readBodyLimited(request, 2_000);
  let body;
  try {
    body = JSON.parse(text ?? "");
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await timingSafeEqualStrings(password, env.VIEW_PASSWORD))) {
    // 総当たりを遅くする(Worker 側で防げるのは、この待ちだけ。長いパスワードを使うこと)
    await new Promise((resolve) => setTimeout(resolve, 800));
    return json({ error: "wrong_password" }, 401);
  }
  const value = await signSession(env.VIEW_PASSWORD);
  const secure = url.protocol === "https:";
  return json({ ok: true }, 200, { "set-cookie": sessionCookieHeader(value, SESSION_TTL_SECONDS, secure) });
}

function handleLogout(url) {
  return json({ ok: true }, 200, { "set-cookie": sessionCookieHeader("", 0, url.protocol === "https:") });
}

// ------------------------------------------------------------------ 取り込み

/** 本文を上限つきで読む(上限を超えたら null)。全体を無制限にバッファしない。 */
async function readBodyLimited(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const UPSERT_ARTICLE_SQL = `
INSERT INTO articles
  (url_hash, url, title, source_type, platform, categories, label, keywords, review, status,
   published, collected_at, summary, summary_src, merged_into, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(url_hash) DO UPDATE SET
  url = excluded.url, title = excluded.title, source_type = excluded.source_type,
  platform = excluded.platform, categories = excluded.categories, label = excluded.label,
  keywords = excluded.keywords, review = excluded.review, status = excluded.status,
  published = excluded.published,
  summary = COALESCE(excluded.summary, articles.summary),
  summary_src = CASE WHEN excluded.summary IS NULL THEN articles.summary_src ELSE excluded.summary_src END,
  merged_into = excluded.merged_into, updated_at = excluded.updated_at`;
// collected_at は最初に収集した時刻を保つ(再送で書き換えない)

const UPSERT_EPISODE_SQL = `
INSERT INTO episodes (id, kind, date, category, headline, json, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  headline = excluded.headline, json = excluded.json, updated_at = excluded.updated_at`;

const UPSERT_REPORT_SQL = `
INSERT INTO reports (id, kind, date, title, json, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title, json = excluded.json, updated_at = excluded.updated_at`;

// detected_at は最初に検知した時刻を保つ
const UPSERT_WATCH_SQL = `
INSERT INTO watch (url, watch, title, detected_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(url) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`;

const UPSERT_META_SQL =
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

async function runInBatches(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

async function handleIngest(request, env) {
  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) return json({ error: "payload_too_large" }, 413);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const result = validateIngest(body);
  if (!result.ok) return json({ error: result.error }, result.status);

  const now = new Date();
  const nowIso = now.toISOString();

  await runInBatches(
    env.DB,
    result.accepted.map((a) =>
      env.DB.prepare(UPSERT_ARTICLE_SQL).bind(
        a.url_hash, a.url, a.title, a.source_type, a.platform, a.categories, a.label, a.keywords,
        a.review, a.status, a.published, a.collected_at, a.summary, a.summary_src, a.merged_into, nowIso,
      ),
    ),
  );
  await runInBatches(
    env.DB,
    result.episodes.map((e) =>
      env.DB.prepare(UPSERT_EPISODE_SQL).bind(e.id, e.kind, e.date, e.category, e.headline, e.json, nowIso),
    ),
  );

  await runInBatches(
    env.DB,
    result.reports.map((r) =>
      env.DB.prepare(UPSERT_REPORT_SQL).bind(r.id, r.kind, r.date, r.title, r.json, nowIso),
    ),
  );
  await runInBatches(
    env.DB,
    result.watch.map((w) =>
      env.DB.prepare(UPSERT_WATCH_SQL).bind(w.url, w.watch, w.title, w.detected_at, nowIso),
    ),
  );

  // 保持期間を過ぎた記事・日次の episode を消す(設計 §4.3: 保持90日。週次は小さいので残す)
  const days = Math.max(1, Number(env.RETENTION_DAYS) || 90);
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const purged = await env.DB.prepare("DELETE FROM articles WHERE collected_at < ?")
    .bind(cutoff.toISOString().slice(0, 19) + "Z")
    .run();
  await env.DB.prepare("DELETE FROM episodes WHERE kind = 'daily' AND date < ?")
    .bind(cutoff.toISOString().slice(0, 10))
    .run();

  // 古い検知(ウォッチ)も、記事と同じ保持期間で消す
  await env.DB.prepare("DELETE FROM watch WHERE detected_at < ?")
    .bind(cutoff.toISOString().slice(0, 19) + "Z")
    .run();

  const accepted = result.accepted.length + result.episodes.length + result.reports.length + result.watch.length;
  const lastIngest = {
    received_at: nowIso,
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    episodes: result.episodes.length,
    episodes_rejected: result.rejectedEpisodes.length,
    reports: result.reports.length,
    reports_rejected: result.rejectedReports.length,
    watch: result.watch.length,
    purged: purged.meta?.changes ?? 0,
    run: result.run,
  };
  await env.DB.prepare(UPSERT_META_SQL).bind("last_ingest", JSON.stringify(lastIngest)).run();
  // 取り込みが止まったことに気づけるよう、「最後に1件以上受け付けた時刻」を別に持つ(全件拒否で上書きしない)
  // (失敗の状態だけを送る取り込みも「実行された」合図なので数える)
  const submitted =
    accepted + result.rejected.length + result.rejectedEpisodes.length + result.rejectedReports.length + result.rejectedWatch.length;
  const heartbeatOnly = submitted === 0 && result.failures !== null;
  if (accepted > 0 || heartbeatOnly) {
    await env.DB.prepare(UPSERT_META_SQL).bind("last_success_at", nowIso).run();
  }
  // 日次の実行の状態(run)は、送られてきたときだけ別に残す。レポートだけ・ウォッチだけの送信で消えないように
  if (Object.keys(result.run).length > 0) {
    await env.DB.prepare(UPSERT_META_SQL)
      .bind("last_run", JSON.stringify({ received_at: nowIso, ...result.run }))
      .run();
  }
  // 失敗した収集元は、送られてきたときだけ更新する(null = 送られていない)
  if (result.failures !== null) {
    await env.DB.prepare(UPSERT_META_SQL).bind("last_failures", JSON.stringify(result.failures)).run();
  }

  console.log(
    JSON.stringify({
      message: "ingest",
      accepted: lastIngest.accepted,
      episodes: lastIngest.episodes,
      reports: lastIngest.reports,
      watch: lastIngest.watch,
      rejected: lastIngest.rejected,
    }),
  );

  // 送られた記事・episode が1件も受け付けられなかった = 契約違反。呼び出し側が気づけるよう 422 で返す
  const status = submitted > 0 && accepted === 0 ? 422 : 200;
  return json(
    {
      ok: status === 200,
      accepted: lastIngest.accepted,
      rejected: lastIngest.rejected,
      episodes: lastIngest.episodes,
      reports: lastIngest.reports,
      watch: lastIngest.watch,
      errors: [
        ...result.rejected.slice(0, 5),
        ...result.rejectedEpisodes.slice(0, 5),
        ...result.rejectedReports.slice(0, 5),
        ...result.rejectedWatch.slice(0, 5),
      ],
    },
    status,
  );
}

// ------------------------------------------------------------------ 読み出し

const rowToArticle = (r) => ({
  url_hash: r.url_hash,
  url: r.url,
  title: r.title,
  source_type: r.source_type,
  platform: r.platform,
  categories: JSON.parse(r.categories),
  label: r.label,
  keywords: JSON.parse(r.keywords),
  review: r.review === 1,
  status: r.status,
  published: r.published,
  collected_at: r.collected_at,
  summary: r.summary,
  summary_src: r.summary_src,
  merged_into: r.merged_into,
});

async function handleArticles(url, env) {
  const q = buildArticleQuery(url.searchParams);
  if (!q.ok) return json({ error: q.error }, 400);

  const [list, count] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM articles ${q.where}
       ORDER BY COALESCE(published, substr(collected_at, 1, 10)) DESC, collected_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(...q.params, q.limit, q.offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM articles ${q.where}`).bind(...q.params).first(),
  ]);

  return json({ total: count?.n ?? 0, limit: q.limit, offset: q.offset, articles: list.results.map(rowToArticle) });
}

const rowToEpisode = (r) => ({
  id: r.id,
  kind: r.kind,
  date: r.date,
  category: r.category,
  headline: r.headline,
  updated_at: r.updated_at,
  data: JSON.parse(r.json),
});

async function handleEpisodes(url, env) {
  const q = buildEpisodeQuery(url.searchParams);
  if (!q.ok) return json({ error: q.error }, 400);

  let date = q.date;
  if (date === "latest") {
    const latest = await env.DB.prepare("SELECT MAX(date) AS d FROM episodes WHERE kind = ?").bind(q.kind).first();
    date = latest?.d ?? null;
    if (date === null) return json({ date: null, episodes: [] });
  }

  const params = [q.kind, date];
  let where = "kind = ? AND date = ?";
  if (q.category === "all") {
    where += " AND category IS NULL";
  } else if (q.category !== null) {
    where += " AND category = ?";
    params.push(q.category);
  }
  const rows = await env.DB.prepare(`SELECT * FROM episodes WHERE ${where} ORDER BY category IS NOT NULL, category`)
    .bind(...params)
    .all();
  return json({ date, episodes: rows.results.map(rowToEpisode) });
}

async function handleEpisodeDates(url, env) {
  const kind = url.searchParams.get("kind") ?? "daily";
  if (!["daily", "weekly"].includes(kind)) return json({ error: "bad_kind" }, 400);
  const rows = await env.DB.prepare("SELECT DISTINCT date FROM episodes WHERE kind = ? ORDER BY date DESC LIMIT 60")
    .bind(kind)
    .all();
  return json({ kind, dates: rows.results.map((r) => r.date) });
}

async function handleStatus(env) {
  const [totals, byCategory, lastIngest, lastSuccess, lastFailures, latestDaily, latestWeekly, reportStat, watchStat, lastRun] =
    await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(review), 0) AS review FROM articles WHERE status = 'added'",
    ).first(),
    env.DB.prepare(
      `SELECT j.value AS category, COUNT(*) AS n
       FROM articles, json_each(articles.categories) AS j
       WHERE articles.status = 'added' GROUP BY j.value`,
    ).all(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'last_ingest'").first(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'last_success_at'").first(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'last_failures'").first(),
    env.DB.prepare("SELECT MAX(date) AS d FROM episodes WHERE kind = 'daily'").first(),
    env.DB.prepare("SELECT MAX(date) AS d FROM episodes WHERE kind = 'weekly'").first(),
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(date) AS d FROM reports").first(),
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(detected_at) AS d FROM watch").first(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'last_run'").first(),
  ]);

  return json({
    // total は URL 単位(複数カテゴリの記事を重複して数えない。設計 §2.2)。by_category はカテゴリごとの件数なので合計は total を超えうる
    articles: {
      total: totals?.total ?? 0,
      review: totals?.review ?? 0,
      by_category: Object.fromEntries(byCategory.results.map((r) => [r.category, r.n])),
    },
    // last_ingest: 直近の取り込み(全件拒否でも記録する) / last_success_at: 最後に1件以上受け付けた時刻
    last_ingest: lastIngest ? JSON.parse(lastIngest.value) : null,
    last_success_at: lastSuccess ? lastSuccess.value : null,
    // last_run: 直近の日次の実行の状態(取得件数・収集元別・新規など)。run を伴う送信のときだけ更新される
    last_run: lastRun ? JSON.parse(lastRun.value) : null,
    failures: lastFailures ? JSON.parse(lastFailures.value) : [],
    episodes: { latest_daily: latestDaily?.d ?? null, latest_weekly: latestWeekly?.d ?? null },
    reports: { total: reportStat?.n ?? 0, latest: reportStat?.d ?? null },
    watch: { total: watchStat?.n ?? 0, latest: watchStat?.d ?? null },
  });
}

// ------------------------------------------------------------------ レポート・ウォッチ

async function handleReportList(url, env) {
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const rows = await env.DB.prepare(
    `SELECT id, kind, date, title, updated_at,
            json_extract(json, '$.week') AS week,
            json_array_length(json, '$.sections') AS sections
     FROM reports ORDER BY date DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return json({ reports: rows.results });
}

async function handleReport(env, id) {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not_found" }, 404);
  const body = JSON.parse(row.json);
  return json({ id: row.id, kind: row.kind, date: row.date, title: row.title, updated_at: row.updated_at, ...body });
}

async function handleWatch(env) {
  const rows = await env.DB.prepare(
    "SELECT watch, title, url, detected_at FROM watch ORDER BY detected_at DESC LIMIT 50",
  ).all();
  return json({ items: rows.results });
}

// ------------------------------------------------------------------ ボード

async function handleBoardList(env) {
  const rows = await env.DB.prepare(
    `SELECT b.url_hash, b.state, b.note, b.updated_at,
            a.url, a.title, a.platform, a.categories, a.published, a.collected_at, a.summary, a.review
     FROM board b LEFT JOIN articles a ON a.url_hash = b.url_hash
     ORDER BY b.updated_at DESC LIMIT 500`,
  ).all();
  return json({
    states: BOARD_STATES,
    items: rows.results.map((r) => ({
      url_hash: r.url_hash,
      state: r.state,
      note: r.note,
      updated_at: r.updated_at,
      // 記事が保持期間を過ぎて消えている場合は、記事側の項目が null になる
      article: r.url
        ? {
            url: r.url,
            title: r.title,
            platform: r.platform,
            categories: JSON.parse(r.categories),
            published: r.published,
            collected_at: r.collected_at,
            summary: r.summary,
            review: r.review === 1,
          }
        : null,
    })),
  });
}

async function handleBoardWrite(request, env, urlHash, method) {
  const nowIso = new Date().toISOString();

  if (method === "DELETE") {
    await env.DB.prepare("DELETE FROM board WHERE url_hash = ?").bind(urlHash).run();
    return json({ ok: true, url_hash: urlHash, state: "unread" });
  }

  const text = await readBodyLimited(request, 2_000);
  if (text === null) return json({ error: "payload_too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const v = validateBoardInput(body);
  if (!v.ok) return json({ error: v.error }, 400);

  if (v.state === "unread") {
    await env.DB.prepare("DELETE FROM board WHERE url_hash = ?").bind(urlHash).run();
    return json({ ok: true, url_hash: urlHash, state: "unread" });
  }
  await env.DB.prepare(
    `INSERT INTO board (url_hash, state, note, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(url_hash) DO UPDATE SET state = excluded.state, note = excluded.note, updated_at = excluded.updated_at`,
  ).bind(urlHash, v.state, v.note, nowIso).run();
  return json({ ok: true, url_hash: urlHash, state: v.state, note: v.note, updated_at: nowIso });
}
