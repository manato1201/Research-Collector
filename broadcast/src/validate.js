// 取り込みの検証と、記事APIのクエリ組み立て(純粋な関数。Workers のランタイムに依存しない = node でテストできる)

export const SCHEMA_VERSION = 1;

// 受け付けるカテゴリ。ローカル限定の分野(notebook_ids_local.py)はここに無いので、
// 万が一送られてきても受け付けない(設計 §1.1・§8「ローカル限定の分野は取り込まない」)。
export const CATEGORIES = [
  "game_dev_tech",
  "graphics_research",
  "software_engineering",
];
export const STATUSES = ["added", "failed", "merged"];

export const MAX_BODY_BYTES = 1_000_000;
export const MAX_ARTICLES = 200;

const HASH_RE = /^[0-9a-f]{16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const isStr = (v, min, max) =>
  typeof v === "string" && v.length >= min && v.length <= max;
const isHttpUrl = (v) => isStr(v, 8, 2048) && /^https?:\/\//i.test(v);

/**
 * 1件の記事を検証して、保存する形に整える。
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateArticle(a) {
  if (a === null || typeof a !== "object" || Array.isArray(a))
    return { ok: false, error: "not_an_object" };

  if (!isStr(a.url_hash, 16, 16) || !HASH_RE.test(a.url_hash))
    return { ok: false, error: "bad_url_hash" };
  if (!isHttpUrl(a.url)) return { ok: false, error: "bad_url" };
  if (!isStr(a.title, 1, 500)) return { ok: false, error: "bad_title" };
  if (!isStr(a.source_type, 1, 40))
    return { ok: false, error: "bad_source_type" };
  if (!isStr(a.platform, 1, 40)) return { ok: false, error: "bad_platform" };

  if (
    !Array.isArray(a.categories) ||
    a.categories.length === 0 ||
    a.categories.length > CATEGORIES.length
  ) {
    return { ok: false, error: "bad_categories" };
  }
  if (!a.categories.every((c) => CATEGORIES.includes(c)))
    return { ok: false, error: "category_not_allowed" };

  if (!STATUSES.includes(a.status)) return { ok: false, error: "bad_status" };
  if (!isStr(a.collected_at, 20, 20) || !DATETIME_RE.test(a.collected_at))
    return { ok: false, error: "bad_collected_at" };

  const published = a.published ?? null;
  if (
    published !== null &&
    !(isStr(published, 10, 10) && DATE_RE.test(published))
  )
    return { ok: false, error: "bad_published" };

  const label = a.label ?? null;
  if (label !== null && !isStr(label, 1, 40))
    return { ok: false, error: "bad_label" };

  const keywords = a.keywords ?? [];
  if (
    !Array.isArray(keywords) ||
    keywords.length > 10 ||
    !keywords.every((k) => isStr(k, 1, 60))
  ) {
    return { ok: false, error: "bad_keywords" };
  }

  const summary = a.summary ?? null;
  if (summary !== null && !isStr(summary, 1, 400))
    return { ok: false, error: "bad_summary" };
  const summarySrc = a.summary_src ?? null;
  if (summarySrc !== null && !["feed", "ai"].includes(summarySrc))
    return { ok: false, error: "bad_summary_src" };

  const mergedInto = a.merged_into ?? null;
  if (mergedInto !== null && !isHttpUrl(mergedInto))
    return { ok: false, error: "bad_merged_into" };

  // X の投稿は本文を再掲載しない方針(設計 §5)。要約が付いて届いても保存しない。
  const noBody = a.source_type === "x_post";

  return {
    ok: true,
    value: {
      url_hash: a.url_hash,
      url: a.url,
      title: a.title,
      source_type: a.source_type,
      platform: a.platform,
      categories: JSON.stringify([...new Set(a.categories)]),
      label,
      keywords: JSON.stringify(keywords),
      review: a.review === true ? 1 : 0,
      status: a.status,
      published,
      collected_at: a.collected_at,
      summary: noBody ? null : summary,
      summary_src: noBody ? null : summarySrc,
      merged_into: mergedInto,
    },
  };
}

/**
 * 取り込みのリクエスト本体を検証する。
 * @returns {{ok: false, status: number, error: string} | {ok: true, accepted: object[], rejected: {index:number,error:string}[], run: object}}
 */
export function validateIngest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { ok: false, status: 400, error: "body_must_be_an_object" };
  if (body.schema !== SCHEMA_VERSION)
    return { ok: false, status: 400, error: "unsupported_schema" };
  if (!Array.isArray(body.articles))
    return { ok: false, status: 400, error: "articles_must_be_an_array" };
  if (body.articles.length === 0)
    return { ok: false, status: 400, error: "articles_is_empty" };
  if (body.articles.length > MAX_ARTICLES)
    return { ok: false, status: 413, error: "too_many_articles" };

  const accepted = [];
  const rejected = [];
  const seen = new Set();
  body.articles.forEach((raw, index) => {
    const r = validateArticle(raw);
    if (!r.ok) {
      rejected.push({ index, error: r.error });
    } else if (seen.has(r.value.url_hash)) {
      rejected.push({ index, error: "duplicate_in_request" });
    } else {
      seen.add(r.value.url_hash);
      accepted.push(r.value);
    }
  });

  // run: 実行の状態(健康状態)。数値と短い文字列だけを通す
  const run = {};
  if (body.run && typeof body.run === "object" && !Array.isArray(body.run)) {
    for (const [k, v] of Object.entries(body.run)) {
      if (
        /^[a-z_]{1,32}$/.test(k) &&
        (typeof v === "number" || (typeof v === "string" && v.length <= 40))
      )
        run[k] = v;
    }
  }
  return { ok: true, accepted, rejected, run };
}

/**
 * GET /api/articles のクエリを、SQLと束縛値にする。
 * @returns {{ok: false, error: string} | {ok: true, where: string, params: any[], limit: number, offset: number}}
 */
export function buildArticleQuery(searchParams) {
  const clauses = [];
  const params = [];

  const category = searchParams.get("category");
  if (category !== null) {
    if (!CATEGORIES.includes(category))
      return { ok: false, error: "bad_category" };
    // 複数カテゴリの記事は、どのカテゴリで絞っても出る(設計 §2.2)
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(articles.categories) WHERE value = ?)",
    );
    params.push(category);
  }

  const status = searchParams.get("status");
  if (status !== null) {
    if (!STATUSES.includes(status)) return { ok: false, error: "bad_status" };
    clauses.push("status = ?");
    params.push(status);
  }

  const since = searchParams.get("since");
  if (since !== null) {
    if (!DATE_RE.test(since)) return { ok: false, error: "bad_since" };
    clauses.push("COALESCE(published, substr(collected_at, 1, 10)) >= ?");
    params.push(since);
  }

  if (searchParams.get("review") === "1") clauses.push("review = 1");

  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return { ok: false, error: "bad_limit" };
  if (!Number.isInteger(offset) || offset < 0 || offset > 5000)
    return { ok: false, error: "bad_offset" };

  return {
    ok: true,
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
    limit,
    offset,
  };
}
