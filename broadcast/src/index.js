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
//   POST /api/enrich       解説(これは何か・何ができるか・どう応用できるか)を、Workers AI で作る(Bearer のみ。1回 最大8件)
//   GET  /api/insights?hashes=…   記事の解説(AI が書いたもの。無ければ、出典の種類ごとの定型の解説)
//   GET  /api/search?q=     記事の検索(3文字以上は全文検索 FTS5 trigram、短い語は LIKE)
//   GET  /api/watchwords    ウォッチワードごとの直近7日の件数と新着
//   GET  /api/prefs / PUT /api/prefs/{key}   設定(ウォッチワード・関連プロジェクト・非表示の収集元)
//   GET  /api/sources       収集元ごとの件数(非表示の設定に使う)
//   POST /api/board/bulk    ボードをまとめて更新(既読にする等。最大200件)
//   POST /api/board/import  ボードの読み込み(書き出した JSON から。既定では既存の状態を変えない。最大500件)
//   GET  /api/export?table=…&offset=…   バックアップ用の書き出し(Bearer のみ。ページごと)
//   GET  /api/status        件数(URL単位)・カテゴリ別・直近の取り込み・失敗した収集元
//   GET  /api/health        生存確認(認証なし。データは返さない)
// それ以外は静的アセット(public/。サイトの本体)。サイト自体にデータは入っていない。

import {
  buildMessages,
  buildTitleMessages,
  extractText,
  fallbackInsight,
  hasBasis,
  INSIGHT_VERSION,
  MIN_SUMMARY_CHARS,
  parseInsight,
  parseTitle,
  titleIsFaithful,
} from "./insights.js";
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
  EXPORT_TABLES,
  escapeLike,
  MAX_BODY_BYTES,
  PREF_KEYS,
  parseSearch,
  resolveCategories,
  validateBoardImport,
  validateBoardInput,
  validateIngest,
  validatePref,
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
      const message = String(err?.message ?? err);
      console.error(JSON.stringify({ message: "unhandled error", path: url.pathname, error: message }));
      // D1 の無料枠(アカウント全体で 1日の読み取り行数)を超えると、UTC 0時まで全クエリが失敗する。原因が分かるよう 503 で返す
      if (/exceeded D1's free tier/i.test(message)) return json({ error: "d1_quota_exceeded" }, 503, { "retry-after": "3600" });
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
  // 解説の生成は、機械(Bearer)だけ。Workers AI の無料枠(1日 10,000 Neurons)を、誰かに使われないように
  if (pathname === "/api/enrich") {
    if (method !== "POST") return methodNotAllowed("POST");
    const denied = await requireBearer(request, env);
    if (denied) return denied;
    return handleEnrich(env, url);
  }

  if (pathname === "/api/board/bulk") {
    if (method !== "POST") return methodNotAllowed("POST");
    return withAuth(request, env, url, true, () => handleBoardBulk(request, env));
  }
  if (pathname === "/api/board/import") {
    if (method !== "POST") return methodNotAllowed("POST");
    return withAuth(request, env, url, true, () => handleBoardImport(request, env));
  }

  // バックアップ用の書き出しは、機械(Bearer)だけ。Cookie では許可しない
  if (pathname === "/api/export") {
    if (method !== "GET") return methodNotAllowed("GET");
    const denied = await requireBearer(request, env);
    if (denied) return denied;
    return handleExport(url, env);
  }

  const pref = /^\/api\/prefs\/([a-z_]+)$/.exec(pathname);
  if (pref) {
    if (method !== "PUT") return methodNotAllowed("PUT");
    return withAuth(request, env, url, true, () => handlePrefWrite(request, env, pref[1]));
  }

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
    let id;
    try {
      id = decodeURIComponent(report[1]);
    } catch {
      return json({ error: "bad_report_id" }, 400);
    }
    return withAuth(request, env, url, false, () => handleReport(env, id));
  }

  const reads = {
    "/api/articles": () => handleArticles(url, env),
    "/api/categories": () => handleCategories(env),
    "/api/search": () => handleSearch(url, env),
    "/api/insights": () => handleInsights(url, env),
    "/api/watchwords": () => handleWatchwords(env),
    "/api/prefs": () => handlePrefsRead(env),
    "/api/sources": () => handleSources(env),
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

const UPSERT_PREF_SQL = `
INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

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

  const result = validateIngest(body, resolveCategories(env.EXTRA_CATEGORIES).all);
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
  // 記事と一緒に、持ち主を失った解説も消す(board は、記事が消えてもメモを残す設計なので消さない)
  if ((purged.meta?.changes ?? 0) > 0) {
    await env.DB.prepare("DELETE FROM insights WHERE url_hash NOT IN (SELECT url_hash FROM articles)").run();
  }

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

/** 表示するカテゴリ(基本の3つ + 環境変数 EXTRA_CATEGORIES の追加分)。サイトはこれで画面を組み立てる。 */
function handleCategories(env) {
  const { extra } = resolveCategories(env.EXTRA_CATEGORIES);
  return json({
    base: ["game_dev_tech", "graphics_research", "software_engineering"],
    extra: Object.entries(extra).map(([id, label]) => ({ id, label })),
  });
}

async function handleArticles(url, env) {
  const q = buildArticleQuery(url.searchParams, resolveCategories(env.EXTRA_CATEGORIES).all);
  if (!q.ok) return json({ error: q.error }, 400);

  const [list, count] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM articles ${q.where}
       ORDER BY ${q.order}
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
  const q = buildEpisodeQuery(url.searchParams, resolveCategories(env.EXTRA_CATEGORIES).all);
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

// ------------------------------------------------------------------ 解説(Workers AI)

const DEFAULT_INSIGHT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

// 解説が無い(または版が古い)記事。要約が十分にあるか、題名が日本語でない(日本語の見出しを付けられる)ものだけ
const PENDING_SQL = `
  FROM articles a LEFT JOIN insights i ON i.url_hash = a.url_hash
  WHERE a.status = 'added' AND (i.url_hash IS NULL OR i.ver < ?)
    AND (length(COALESCE(a.summary, '')) >= ? OR a.title NOT GLOB '*[ぁ-ゟ゠-ヿ一-鿿]*')`;
const PENDING_BINDS = [INSIGHT_VERSION, MIN_SUMMARY_CHARS];

const INSERT_INSIGHT_SQL = `
  INSERT OR REPLACE INTO insights (url_hash, what, use, apply, title_ja, term, term_meaning, source, model, created_at, ver)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 解説が無い(または古い版の)記事を、新しい順に最大 limit 件、AI で作って保存する。
 * - 要約が十分にある記事: 初心者向けの解説(日本語の見出し・かんたんな概要・何が分かるか・応用・用語)。source = 'ai'
 * - 要約が無い英語の記事: 日本語の見出しだけ(題名の翻訳なので、作り話になりにくい)。source = 'title'
 * - 一時的な失敗(API エラー)は、行を作らない(次回また試す)。
 * - 出力が使えない形だったものは、source = 'none' で残し、再試行しない(同じ記事に枠を使い続けない)。
 */
async function handleEnrich(env, url) {
  if (!env.AI) return json({ error: "ai_not_configured" }, 503);
  const limit = Math.min(8, Math.max(1, Number(url.searchParams.get("limit")) || 5));
  const model = env.INSIGHT_MODEL || DEFAULT_INSIGHT_MODEL;
  const noThink = model.includes("qwen3");
  const { projects } = await readPrefs(env);

  const rows = await env.DB.prepare(`SELECT a.* ${PENDING_SQL} ORDER BY a.collected_at DESC LIMIT ?`)
    .bind(...PENDING_BINDS, limit)
    .all();

  let ok = 0;
  let titled = 0;
  let unusable = 0;
  let errors = 0;
  const nowIso = new Date().toISOString();
  for (const row of rows.results) {
    const article = rowToArticle(row);
    const full = hasBasis(article);
    let text;
    try {
      const result = await env.AI.run(model, {
        messages: full ? buildMessages(article, { projects, noThink }) : buildTitleMessages(article, { noThink }),
        max_tokens: full ? 700 : 120,
        temperature: 0.3,
      });
      text = extractText(result);
    } catch (err) {
      errors++;
      console.error(JSON.stringify({ message: "ai failed", error: String(err?.message ?? err).slice(0, 200) }));
      continue;
    }
    const h = article.url_hash;
    if (full) {
      const parsed = parseInsight(text);
      if (parsed) {
        // 見出しが元の題名の綴りを崩していたら、見出しだけ捨てる(解説の本文は使う)
        if (parsed.title_ja && !titleIsFaithful(parsed.title_ja, article.title)) parsed.title_ja = null;
        await env.DB.prepare(INSERT_INSIGHT_SQL)
          .bind(h, parsed.what, parsed.use, parsed.apply, parsed.title_ja, parsed.term, parsed.term_meaning, "ai", model, nowIso, INSIGHT_VERSION)
          .run();
        ok++;
        continue;
      }
    } else {
      const titleJa = parseTitle(text);
      if (titleJa && titleIsFaithful(titleJa, article.title)) {
        await env.DB.prepare(INSERT_INSIGHT_SQL)
          .bind(h, null, null, null, titleJa, null, null, "title", model, nowIso, INSIGHT_VERSION)
          .run();
        titled++;
        continue;
      }
    }
    await env.DB.prepare(INSERT_INSIGHT_SQL)
      .bind(h, null, null, null, null, null, null, "none", model, nowIso, INSIGHT_VERSION)
      .run();
    unusable++;
  }
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n ${PENDING_SQL}`).bind(...PENDING_BINDS).first();
  return json({ processed: rows.results.length, ok, titled, unusable, errors, pending: pending?.n ?? 0, model });
}

/** 記事の解説。AI が書いたものがあればそれ、無ければ、出典の種類ごとの定型の解説(source = "rule")。 */
async function handleInsights(url, env) {
  const hashes = [...new Set((url.searchParams.get("hashes") ?? "").split(",").map((h) => h.trim()).filter(isUrlHash))].slice(0, 60);
  if (!hashes.length) return json({ insights: {} });
  const rows = await env.DB.prepare(
    `SELECT a.url_hash, a.platform, a.title, i.what, i.use, i.apply, i.title_ja, i.term, i.term_meaning,
            i.source AS isrc, i.model
     FROM articles a LEFT JOIN insights i ON i.url_hash = a.url_hash
     WHERE a.url_hash IN (${hashes.map(() => "?").join(",")})`,
  )
    .bind(...hashes)
    .all();
  const insights = {};
  for (const r of rows.results) {
    if (r.isrc === "ai" && r.what) {
      insights[r.url_hash] = {
        title_ja: r.title_ja,
        what: r.what,
        use: r.use,
        apply: r.apply,
        term: r.term,
        term_meaning: r.term_meaning,
        source: "ai",
        model: r.model,
      };
    } else {
      // AI の解説が無い記事は、出典の種類ごとの定型の解説。日本語の見出しだけ付いていれば、それも添える
      insights[r.url_hash] = {
        ...fallbackInsight({ platform: r.platform, title: r.title }),
        title_ja: r.isrc === "title" ? r.title_ja : null,
        source: "rule",
      };
    }
  }
  return json({ insights });
}

// ------------------------------------------------------------------ 検索・設定・エクスポート

/** 検索の SQL(全文検索か LIKE か)と束縛値。count=true なら件数、そうでなければ記事の行。 */
function buildSearchSql(parsed, { count = false, since = null, limit = 50 } = {}) {
  const params = [];
  let from;
  const where = ["a.status = 'added'"];
  if (parsed.useFts) {
    from = "articles_fts JOIN articles a ON a.rowid = articles_fts.rowid";
    where.unshift("articles_fts MATCH ?");
    params.push(parsed.match);
  } else {
    from = "articles a";
    for (const t of parsed.terms) {
      where.push("(a.title LIKE ? ESCAPE '\\' OR COALESCE(a.summary, '') LIKE ? ESCAPE '\\')");
      const pat = `%${escapeLike(t)}%`;
      params.push(pat, pat);
    }
  }
  if (since) {
    where.push("substr(a.collected_at, 1, 10) >= ?");
    params.push(since);
  }
  let sql = `SELECT ${count ? "COUNT(*) AS n" : "a.*"} FROM ${from} WHERE ${where.join(" AND ")}`;
  if (!count) {
    sql += " ORDER BY COALESCE(a.published, substr(a.collected_at, 1, 10)) DESC, a.collected_at DESC LIMIT ?";
    params.push(limit);
  }
  return { sql, params };
}

async function handleSearch(url, env) {
  const parsed = parseSearch(url.searchParams.get("q"));
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const { sql, params } = buildSearchSql(parsed, { limit });
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ q: url.searchParams.get("q").trim(), mode: parsed.useFts ? "fts" : "like", articles: rows.results.map(rowToArticle) });
}

async function readPrefs(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM prefs").all();
  const out = { watchwords: [], muted_sources: [], projects: [] };
  for (const r of rows.results) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* 壊れた値は無視する */
    }
  }
  return out;
}

async function handlePrefsRead(env) {
  return json(await readPrefs(env));
}

async function handlePrefWrite(request, env, key) {
  if (!PREF_KEYS.includes(key)) return json({ error: "unknown_pref" }, 404);
  const text = await readBodyLimited(request, 10_000);
  if (text === null) return json({ error: "payload_too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const v = validatePref(key, body?.value);
  if (!v.ok) return json({ error: v.error }, 400);
  await env.DB.prepare(UPSERT_PREF_SQL).bind(key, JSON.stringify(v.value), new Date().toISOString()).run();
  return json({ ok: true, key, value: v.value });
}

/** ウォッチワードごとの、直近7日(収集した日)の件数と、新しい記事の見出し(3件)。 */
async function handleWatchwords(env) {
  const { watchwords } = await readPrefs(env);
  if (!watchwords.length) return json({ items: [] });
  const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const parsedAll = watchwords.map((w) => ({ word: w, parsed: parseSearch(w) })).filter((x) => x.parsed.ok);
  const statements = [];
  for (const { parsed } of parsedAll) {
    const c = buildSearchSql(parsed, { count: true, since });
    const l = buildSearchSql(parsed, { since, limit: 3 });
    statements.push(env.DB.prepare(c.sql).bind(...c.params), env.DB.prepare(l.sql).bind(...l.params));
  }
  const results = statements.length ? await env.DB.batch(statements) : [];
  const items = parsedAll.map(({ word }, i) => ({
    word,
    count: results[i * 2].results[0]?.n ?? 0,
    latest: results[i * 2 + 1].results.map((r) => ({ url_hash: r.url_hash, url: r.url, title: r.title, published: r.published })),
  }));
  return json({ since, items });
}

async function handleSources(env) {
  const rows = await env.DB.prepare(
    "SELECT platform, COUNT(*) AS n FROM articles WHERE status = 'added' GROUP BY platform ORDER BY n DESC",
  ).all();
  return json({ sources: rows.results });
}

/** バックアップ用: テーブルをページごとに書き出す(呼び出し側が next をたどる)。CPU 時間を抑えるため1回 最大200行。 */
async function handleExport(url, env) {
  const table = url.searchParams.get("table") ?? "";
  if (!EXPORT_TABLES.includes(table)) return json({ error: "bad_table", tables: EXPORT_TABLES }, 400);
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  // table は許可リストの中のものだけ(SQL に直接入れて安全)
  const rows = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).bind(limit, offset).all();
  const n = rows.results.length;
  return json({ table, offset, count: n, next: n === limit ? offset + n : null, rows: rows.results });
}

async function handleBoardBulk(request, env) {
  const text = await readBodyLimited(request, 20_000);
  if (text === null) return json({ error: "payload_too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const hashes = Array.isArray(body?.hashes) ? [...new Set(body.hashes)] : null;
  if (!hashes || hashes.length === 0 || hashes.length > 200 || !hashes.every(isUrlHash)) {
    return json({ error: "bad_hashes" }, 400);
  }
  const v = validateBoardInput({ state: body.state, note: "" });
  if (!v.ok) return json({ error: v.error }, 400);

  const nowIso = new Date().toISOString();
  let statements;
  if (v.state === "unread") {
    statements = hashes.map((h) => env.DB.prepare("DELETE FROM board WHERE url_hash = ?").bind(h));
  } else if (v.state === "read") {
    // 「まとめて既読」は、すでに 読む / 試す / 保留 に入れた記事の状態を上書きしない
    statements = hashes.map((h) =>
      env.DB.prepare(
        "INSERT INTO board (url_hash, state, note, updated_at) VALUES (?, 'read', '', ?) ON CONFLICT(url_hash) DO NOTHING",
      ).bind(h, nowIso),
    );
  } else {
    statements = hashes.map((h) =>
      env.DB.prepare(
        `INSERT INTO board (url_hash, state, note, updated_at) VALUES (?, ?, '', ?)
         ON CONFLICT(url_hash) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      ).bind(h, v.state, nowIso),
    );
  }
  await runInBatches(env.DB, statements);
  return json({ ok: true, state: v.state, count: hashes.length });
}

/**
 * ボードの読み込み(書き出した JSON から戻す)。既定では、すでにボードにある記事の状態を変えない。
 * overwrite: true のときだけ、既存の状態・メモを上書きする。
 */
async function handleBoardImport(request, env) {
  const text = await readBodyLimited(request, 200_000);
  if (text === null) return json({ error: "payload_too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const v = validateBoardImport(body);
  if (!v.ok) return json({ error: v.error }, 400);

  const existing = new Set();
  for (let i = 0; i < v.items.length; i += 90) {
    const chunk = v.items.slice(i, i + 90);
    const rows = await env.DB.prepare(`SELECT url_hash FROM board WHERE url_hash IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk.map((it) => it.url_hash))
      .all();
    for (const r of rows.results) existing.add(r.url_hash);
  }
  const nowIso = new Date().toISOString();
  const sql = v.overwrite
    ? `INSERT INTO board (url_hash, state, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url_hash) DO UPDATE SET state = excluded.state, note = excluded.note, updated_at = excluded.updated_at`
    : "INSERT INTO board (url_hash, state, note, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(url_hash) DO NOTHING";
  await runInBatches(
    env.DB,
    v.items.map((it) => env.DB.prepare(sql).bind(it.url_hash, it.state, it.note, nowIso)),
  );
  const conflicts = existing.size;
  return json({
    ok: true,
    overwrite: v.overwrite,
    received: v.items.length,
    added: v.items.length - conflicts,
    existing: conflicts,
    updated: v.overwrite ? conflicts : 0,
  });
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
