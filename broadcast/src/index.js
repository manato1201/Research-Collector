// ResearchBroadcast Phase 1 — 取り込み(ingest)と記事API。ResearchBroadcast_DESIGN.md §3・§4
//
//   POST /api/ingest     GitHub Actions(scripts/post_ingest.py)から新規の記事を受け取り、D1 に upsert する
//   GET  /api/articles   記事の一覧(category / status / since / review / limit / offset)
//   GET  /api/status     件数(URL単位)・カテゴリ別・直近の取り込みの状態
//   GET  /api/health     生存確認(認証なし。データは返さない)
//
// 認証: Authorization: Bearer <INGEST_TOKEN>(wrangler secret)。取り込みは常にトークン必須。
//       GET は既定でトークン必須。READ_REQUIRES_TOKEN="false" は Access で全ホスト名を保護した場合のみ。

import {
  buildArticleQuery,
  MAX_BODY_BYTES,
  validateIngest,
} from "./validate.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const BATCH_SIZE = 50;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "unhandled error",
          path: url.pathname,
          error: String(err?.message ?? err),
        }),
      );
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/health") {
    return method === "GET" ? json({ ok: true }) : methodNotAllowed("GET");
  }

  if (pathname === "/api/ingest") {
    if (method !== "POST") return methodNotAllowed("POST");
    const denied = await authorize(request, env);
    if (denied) return denied;
    return handleIngest(request, env);
  }

  if (pathname === "/api/articles" || pathname === "/api/status") {
    if (method !== "GET") return methodNotAllowed("GET");
    if (env.READ_REQUIRES_TOKEN !== "false") {
      const denied = await authorize(request, env);
      if (denied) return denied;
    }
    return pathname === "/api/articles"
      ? handleArticles(url, env)
      : handleStatus(env);
  }

  return json({ error: "not_found" }, 404);
}

const methodNotAllowed = (allow) =>
  json({ error: "method_not_allowed" }, 405, { allow });

// ------------------------------------------------------------------ 認証

/** 認証に失敗したら Response を返す。通ったら null。 */
async function authorize(request, env) {
  if (!env.INGEST_TOKEN) {
    // トークン未設定のまま公開してしまう事故を防ぐ(未設定 = 全拒否)
    console.error(
      JSON.stringify({ message: "INGEST_TOKEN is not configured" }),
    );
    return json({ error: "server_not_configured" }, 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!(await timingSafeEqualStrings(provided, env.INGEST_TOKEN))) {
    return json({ error: "unauthorized" }, 401, {
      "www-authenticate": "Bearer",
    });
  }
  return null;
}

/** 長さに依らず一定時間で比較する(両方を SHA-256 にしてから timingSafeEqual)。 */
async function timingSafeEqualStrings(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
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

const UPSERT_SQL = `
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

  if (result.accepted.length > 0) {
    const stmts = result.accepted.map((a) =>
      env.DB.prepare(UPSERT_SQL).bind(
        a.url_hash,
        a.url,
        a.title,
        a.source_type,
        a.platform,
        a.categories,
        a.label,
        a.keywords,
        a.review,
        a.status,
        a.published,
        a.collected_at,
        a.summary,
        a.summary_src,
        a.merged_into,
        nowIso,
      ),
    );
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      await env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
    }
  }

  // 保持期間を過ぎた記事を消す(設計 §4.3: 保持90日)
  const days = Math.max(1, Number(env.RETENTION_DAYS) || 90);
  const cutoff =
    new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19) +
    "Z";
  const purged = await env.DB.prepare(
    "DELETE FROM articles WHERE collected_at < ?",
  )
    .bind(cutoff)
    .run();

  const lastIngest = {
    received_at: nowIso,
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    purged: purged.meta?.changes ?? 0,
    run: result.run,
  };
  const upsertMeta =
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
  await env.DB.prepare(upsertMeta).bind("last_ingest", JSON.stringify(lastIngest)).run();
  // 取り込みが止まったことに気づけるよう、「最後に1件以上受け付けた時刻」を別に持つ(全件拒否で上書きしない)
  if (result.accepted.length > 0) {
    await env.DB.prepare(upsertMeta).bind("last_success_at", nowIso).run();
  }

  console.log(
    JSON.stringify({
      message: "ingest",
      accepted: lastIngest.accepted,
      rejected: lastIngest.rejected,
    }),
  );

  // 1件も受け付けられなかった = 契約違反。呼び出し側が気づけるよう 422 で返す
  const status = result.accepted.length === 0 ? 422 : 200;
  return json(
    {
      ok: status === 200,
      accepted: lastIngest.accepted,
      rejected: lastIngest.rejected,
      errors: result.rejected.slice(0, 5),
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
    )
      .bind(...q.params, q.limit, q.offset)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM articles ${q.where}`)
      .bind(...q.params)
      .first(),
  ]);

  return json({
    total: count?.n ?? 0,
    limit: q.limit,
    offset: q.offset,
    articles: list.results.map(rowToArticle),
  });
}

async function handleStatus(env) {
  const [totals, byCategory, lastIngest, lastSuccess] = await Promise.all([
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
  ]);

  return json({
    // total は URL 単位(複数カテゴリの記事を重複して数えない。設計 §2.2)。by_category はカテゴリごとの件数なので合計は total を超えうる
    articles: {
      total: totals?.total ?? 0,
      review: totals?.review ?? 0,
      by_category: Object.fromEntries(
        byCategory.results.map((r) => [r.category, r.n]),
      ),
    },
    // last_ingest: 直近の取り込み(全件拒否でも記録する) / last_success_at: 最後に1件以上受け付けた時刻
    last_ingest: lastIngest ? JSON.parse(lastIngest.value) : null,
    last_success_at: lastSuccess ? lastSuccess.value : null,
  });
}
