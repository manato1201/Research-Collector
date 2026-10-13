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

// 追加カテゴリ(任意)。Worker の環境変数 EXTRA_CATEGORIES に、{"id": "表示名", ...} の JSON を入れる。
// 値はリポジトリに置かない(wrangler secret put EXTRA_CATEGORIES)。未設定なら上の3つだけ。
const EXTRA_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
export const MAX_EXTRA_CATEGORIES = 8;

/**
 * @param {string | object | undefined} raw  EXTRA_CATEGORIES の値(JSON 文字列またはオブジェクト)
 * @returns {{ all: string[], extra: Record<string, string> }}  all = 基本 + 追加の id。extra = 追加の id → 表示名
 */
export function resolveCategories(raw) {
  const extra = {};
  let obj = null;
  try {
    obj = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : null) : (raw ?? null);
  } catch {
    obj = null; // 壊れた設定は無視する(基本の3つだけで動く)
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [id, label] of Object.entries(obj)) {
      if (Object.keys(extra).length >= MAX_EXTRA_CATEGORIES) break;
      if (EXTRA_ID_RE.test(id) && !CATEGORIES.includes(id) && typeof label === "string" && label.length >= 1 && label.length <= 40) {
        extra[id] = label;
      }
    }
  }
  return { all: [...CATEGORIES, ...Object.keys(extra)], extra };
}

export const MAX_BODY_BYTES = 1_000_000;
export const MAX_ARTICLES = 200;
export const MAX_EPISODES = 20;
export const MAX_EPISODE_BYTES = 200_000;
export const MAX_REPORTS = 5;
export const MAX_REPORT_BYTES = 300_000;
export const MAX_WATCH = 50;

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
export function validateArticle(a, categories = CATEGORIES) {
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
    a.categories.length > categories.length
  ) {
    return { ok: false, error: "bad_categories" };
  }
  if (!a.categories.every((c) => categories.includes(c)))
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
export function validateIngest(body, categories = CATEGORIES) {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { ok: false, status: 400, error: "body_must_be_an_object" };
  if (body.schema !== SCHEMA_VERSION)
    return { ok: false, status: 400, error: "unsupported_schema" };
  // articles は省略・空でもよい(episode と失敗の状態だけを送る場合)。ただし何も無い取り込みは受け付けない
  const articles = body.articles ?? [];
  if (!Array.isArray(articles))
    return { ok: false, status: 400, error: "articles_must_be_an_array" };
  if (articles.length > MAX_ARTICLES)
    return { ok: false, status: 413, error: "too_many_articles" };

  const episodesIn = body.episodes ?? [];
  if (!Array.isArray(episodesIn))
    return { ok: false, status: 400, error: "episodes_must_be_an_array" };
  if (episodesIn.length > MAX_EPISODES)
    return { ok: false, status: 413, error: "too_many_episodes" };

  const failuresIn = body.failures ?? null;
  if (failuresIn !== null && !Array.isArray(failuresIn))
    return { ok: false, status: 400, error: "failures_must_be_an_array" };

  const reportsIn = body.reports ?? [];
  if (!Array.isArray(reportsIn))
    return { ok: false, status: 400, error: "reports_must_be_an_array" };
  if (reportsIn.length > MAX_REPORTS)
    return { ok: false, status: 413, error: "too_many_reports" };

  const watchIn = body.watch ?? [];
  if (!Array.isArray(watchIn))
    return { ok: false, status: 400, error: "watch_must_be_an_array" };
  if (watchIn.length > MAX_WATCH)
    return { ok: false, status: 413, error: "too_many_watch_items" };

  if (
    articles.length === 0 &&
    episodesIn.length === 0 &&
    reportsIn.length === 0 &&
    watchIn.length === 0 &&
    failuresIn === null
  )
    return { ok: false, status: 400, error: "nothing_to_ingest" };

  const accepted = [];
  const rejected = [];
  const seen = new Set();
  articles.forEach((raw, index) => {
    const r = validateArticle(raw, categories);
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
    // 収集元ごとの取得件数(health.json の by_source)。名前は短く・件数は整数・20件まで
    const bs = body.run.by_source;
    if (bs && typeof bs === "object" && !Array.isArray(bs)) {
      const out = {};
      for (const [name, n] of Object.entries(bs).slice(0, 20)) {
        if (isStr(name, 1, 40) && Number.isInteger(n) && n >= 0 && n <= 100000) out[name] = n;
      }
      run.by_source = out;
    }
  }
  const episodes = [];
  const rejectedEpisodes = [];
  episodesIn.forEach((raw, index) => {
    const r = validateEpisode(raw, categories);
    if (r.ok) episodes.push(r.value);
    else rejectedEpisodes.push({ index, error: r.error });
  });

  // failures: 直近の実行で取得に失敗した収集元(/status の表示用)。null = 送られていない(前回の値を残す)
  const failures =
    failuresIn === null
      ? null
      : failuresIn
          .filter((f) => f && typeof f === "object" && isStr(f.source, 1, 120))
          .slice(0, 20)
          .map((f) => ({ source: f.source, error: isStr(f.error, 0, 200) ? f.error : "" }));

  const reports = [];
  const rejectedReports = [];
  reportsIn.forEach((raw, index) => {
    const r = validateReport(raw, categories);
    if (r.ok) reports.push(r.value);
    else rejectedReports.push({ index, error: r.error });
  });

  const watch = [];
  const rejectedWatch = [];
  const seenWatch = new Set();
  watchIn.forEach((raw, index) => {
    const r = validateWatchItem(raw);
    if (!r.ok) rejectedWatch.push({ index, error: r.error });
    else if (!seenWatch.has(r.value.url)) {
      seenWatch.add(r.value.url);
      watch.push(r.value);
    }
  });

  return {
    ok: true, accepted, rejected, run, episodes, rejectedEpisodes, failures,
    reports, rejectedReports, watch, rejectedWatch,
  };
}

/**
 * GET /api/articles のクエリを、SQLと束縛値にする。
 * @returns {{ok: false, error: string} | {ok: true, where: string, params: any[], limit: number, offset: number}}
 */
export function buildArticleQuery(searchParams, categories = CATEGORIES) {
  const clauses = [];
  const params = [];

  const category = searchParams.get("category");
  if (category !== null) {
    if (!categories.includes(category))
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

  // exclude_platforms: 非表示にする収集元(カンマ区切り。最大40)。設定の「非表示の収集元」で使う
  const exclude = searchParams.get("exclude_platforms");
  if (exclude !== null) {
    const names = exclude.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);
    if (names.some((n) => n.length > 40)) return { ok: false, error: "bad_exclude_platforms" };
    if (names.length) {
      clauses.push(`platform NOT IN (${names.map(() => "?").join(",")})`);
      params.push(...names);
    }
  }

  // collected_since: 収集した日(JST ではなく UTC の日付)がその日以降。公開日が古い論文も「最近集めた」で拾える
  const collectedSince = searchParams.get("collected_since");
  if (collectedSince !== null) {
    if (!DATE_RE.test(collectedSince)) return { ok: false, error: "bad_collected_since" };
    clauses.push("substr(collected_at, 1, 10) >= ?");
    params.push(collectedSince);
  }

  const collectedUntil = searchParams.get("collected_until");
  if (collectedUntil !== null) {
    if (!DATE_RE.test(collectedUntil)) return { ok: false, error: "bad_collected_until" };
    clauses.push("substr(collected_at, 1, 10) <= ?");
    params.push(collectedUntil);
  }

  // until: その日まで(先月の表示など。since と組み合わせて範囲にする)
  const until = searchParams.get("until");
  if (until !== null) {
    if (!DATE_RE.test(until)) return { ok: false, error: "bad_until" };
    clauses.push("COALESCE(published, substr(collected_at, 1, 10)) <= ?");
    params.push(until);
  }

  if (searchParams.get("review") === "1") clauses.push("review = 1");

  // order: published(既定。公開日の新しい順)/ collected(収集した順。追加カテゴリの「最近入ったもの」向け)
  const orderParam = searchParams.get("order") ?? "published";
  if (!["published", "collected"].includes(orderParam)) return { ok: false, error: "bad_order" };
  const order =
    orderParam === "collected"
      ? "collected_at DESC"
      : "COALESCE(published, substr(collected_at, 1, 10)) DESC, collected_at DESC";

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
    order,
    limit,
    offset,
  };
}

// ------------------------------------------------------------------ episode(番組表)

// カテゴリ id は、基本(定数)か、EXTRA_ID_RE を通ったものだけ。正規表現に入れても安全。
const episodeIdRe = (categories) =>
  new RegExp(`^(daily|weekly):([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-W[0-9]{2}):(all|${categories.join("|")})$`);

/**
 * episode 1件の検証。id は `種別:日付:カテゴリ`(日次は YYYY-MM-DD、週次は YYYY-Www)で、
 * kind / date / category は id と一致していなければならない(同じ入力から同じ id = 冪等)。
 * data の中身(記事の項目)は、サイト側が textContent / http(s) のリンクでしか使わない前提で、形だけ確認する。
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateEpisode(e, categories = CATEGORIES) {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return { ok: false, error: "not_an_object" };
  const m = typeof e.id === "string" ? episodeIdRe(categories).exec(e.id) : null;
  if (!m) return { ok: false, error: "bad_episode_id" };
  const [, kind, date, cat] = m;

  if (e.kind !== kind) return { ok: false, error: "kind_mismatch" };
  if (e.date !== date) return { ok: false, error: "date_mismatch" };
  const category = cat === "all" ? null : cat;
  if ((e.category ?? null) !== category) return { ok: false, error: "category_mismatch" };
  if (kind === "daily" && !DATE_RE.test(date)) return { ok: false, error: "bad_date" };
  if (kind === "weekly" && !/^\d{4}-W\d{2}$/.test(date)) return { ok: false, error: "bad_date" };

  if (!isStr(e.headline, 1, 300)) return { ok: false, error: "bad_headline" };
  if (e.data === null || typeof e.data !== "object" || Array.isArray(e.data)) return { ok: false, error: "bad_data" };
  const json = JSON.stringify(e.data);
  if (json.length > MAX_EPISODE_BYTES) return { ok: false, error: "data_too_large" };

  return { ok: true, value: { id: e.id, kind, date, category, headline: e.headline, json } };
}

// ------------------------------------------------------------------ レポート(週次ダイジェスト)

const REPORT_ID_RE = /^digest:(\d{4}-\d{2}-\d{2})$/;

/**
 * 週次ダイジェスト1件の検証。本文は Markdown のテキスト(サイト側が textContent だけで描画する)。
 * セクションのカテゴリは3つの範囲内のみ(ローカル限定の分野は受け付けない)。
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateReport(r, categories = CATEGORIES) {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "not_an_object" };
  const m = typeof r.id === "string" ? REPORT_ID_RE.exec(r.id) : null;
  if (!m) return { ok: false, error: "bad_report_id" };
  if (r.kind !== "digest") return { ok: false, error: "bad_report_kind" };
  if (r.date !== m[1]) return { ok: false, error: "date_mismatch" };
  if (!isStr(r.title, 1, 200)) return { ok: false, error: "bad_title" };

  const week = r.week ?? null;
  if (week !== null && !(isStr(week, 8, 8) && /^\d{4}-W\d{2}$/.test(week))) return { ok: false, error: "bad_week" };
  const generatedAt = r.generated_at ?? null;
  if (generatedAt !== null && !(isStr(generatedAt, 20, 20) && DATETIME_RE.test(generatedAt)))
    return { ok: false, error: "bad_generated_at" };

  if (!Array.isArray(r.sections) || r.sections.length === 0 || r.sections.length > categories.length)
    return { ok: false, error: "bad_sections" };
  const sections = [];
  for (const s of r.sections) {
    if (s === null || typeof s !== "object") return { ok: false, error: "bad_section" };
    if (!categories.includes(s.category)) return { ok: false, error: "category_not_allowed" };
    if (!isStr(s.heading, 1, 100)) return { ok: false, error: "bad_heading" };
    if (!isStr(s.markdown, 1, 120_000)) return { ok: false, error: "bad_markdown" };
    sections.push({ category: s.category, heading: s.heading, markdown: s.markdown });
  }
  const intro = r.intro ?? "";
  if (typeof intro !== "string" || intro.length > 4000) return { ok: false, error: "bad_intro" };

  const json = JSON.stringify({ week, generated_at: generatedAt, intro, sections });
  if (json.length > MAX_REPORT_BYTES) return { ok: false, error: "report_too_large" };
  return { ok: true, value: { id: r.id, kind: "digest", date: m[1], title: r.title, json } };
}

/** ウォッチ(配布サイトの新着の通知)1件。導入はしない・通知のみ。 */
export function validateWatchItem(w) {
  if (w === null || typeof w !== "object" || Array.isArray(w)) return { ok: false, error: "not_an_object" };
  if (!isStr(w.watch, 1, 40)) return { ok: false, error: "bad_watch" };
  if (!isStr(w.title, 1, 200)) return { ok: false, error: "bad_title" };
  if (!isHttpUrl(w.url)) return { ok: false, error: "bad_url" };
  if (!(isStr(w.detected_at, 20, 20) && DATETIME_RE.test(w.detected_at))) return { ok: false, error: "bad_detected_at" };
  return { ok: true, value: { watch: w.watch, title: w.title, url: w.url, detected_at: w.detected_at } };
}

// ------------------------------------------------------------------ 設定(ウォッチワード・関連プロジェクト・非表示の収集元)

const isShort = (v, max) => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max;

/**
 * 設定1件の検証。値は、サイトを使う人が自分で決めるもの(ウォッチワード等)。
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function validatePref(key, value) {
  const uniq = (arr) => [...new Set(arr.map((v) => v.trim()))];
  if (key === "watchwords") {
    if (!Array.isArray(value) || value.length > 10) return { ok: false, error: "bad_watchwords" };
    if (!value.every((v) => isShort(v, 40))) return { ok: false, error: "bad_watchword" };
    return { ok: true, value: uniq(value) };
  }
  if (key === "muted_sources") {
    if (!Array.isArray(value) || value.length > 40) return { ok: false, error: "bad_muted_sources" };
    if (!value.every((v) => isShort(v, 40))) return { ok: false, error: "bad_muted_source" };
    return { ok: true, value: uniq(value) };
  }
  if (key === "projects") {
    if (!Array.isArray(value) || value.length > 12) return { ok: false, error: "bad_projects" };
    const out = [];
    for (const p of value) {
      if (p === null || typeof p !== "object" || !isShort(p.name, 40)) return { ok: false, error: "bad_project" };
      if (!Array.isArray(p.keywords) || p.keywords.length > 20 || !p.keywords.every((k) => isShort(k, 40)))
        return { ok: false, error: "bad_project_keywords" };
      out.push({ name: p.name.trim(), keywords: uniq(p.keywords) });
    }
    return { ok: true, value: out };
  }
  return { ok: false, error: "unknown_pref" };
}

export const PREF_KEYS = ["watchwords", "muted_sources", "projects"];

// ------------------------------------------------------------------ 検索

/**
 * 検索語を、検索の方式と束縛値にする。語は空白で区切り、すべてを含む記事(AND)。
 * 3文字以上の語だけなら全文検索(FTS5 trigram。部分一致)、短い語を含むときは LIKE。
 * @returns {{ok: false, error: string} | {ok: true, terms: string[], useFts: boolean, match: string}}
 */
export function parseSearch(q) {
  const text = String(q ?? "").trim();
  if (text.length < 1 || text.length > 60) return { ok: false, error: "bad_query" };
  const terms = text.split(/\s+/).filter(Boolean).slice(0, 5);
  const useFts = terms.every((t) => [...t].length >= 3);
  // FTS5 の文字列は二重引用符で囲み、中の " は "" にする(演算子として解釈させない)
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
  return { ok: true, terms, useFts, match };
}

/** LIKE のワイルドカードを無効にする(ESCAPE '\\' と組み合わせる)。 */
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

// ------------------------------------------------------------------ エクスポート(バックアップ)

export const EXPORT_TABLES = ["articles", "episodes", "reports", "board", "watch", "prefs", "meta"];

// ------------------------------------------------------------------ ボード

// 未読 は「行が無い」状態。reading=読む / try=試す / hold=保留
// read = 既読(読み終えた。一覧では薄く表示し、「既読を隠す」で隠せる)
export const BOARD_STATES = ["reading", "try", "hold", "read"];

/** PUT /api/board/{url_hash} の本文。state が "unread" なら削除(未読に戻す)。 */
export function validateBoardInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body_must_be_an_object" };
  const state = body.state;
  if (state !== "unread" && !BOARD_STATES.includes(state)) return { ok: false, error: "bad_state" };
  const note = body.note ?? "";
  if (typeof note !== "string" || note.length > 200) return { ok: false, error: "bad_note" };
  return { ok: true, state, note };
}

export function isUrlHash(v) {
  return typeof v === "string" && HASH_RE.test(v);
}

/** GET /api/episodes のクエリ。 */
export function buildEpisodeQuery(searchParams, categories = CATEGORIES) {
  const kind = searchParams.get("kind") ?? "daily";
  if (!["daily", "weekly"].includes(kind)) return { ok: false, error: "bad_kind" };

  const date = searchParams.get("date") ?? "latest";
  if (date !== "latest" && !(DATE_RE.test(date) || /^\d{4}-W\d{2}$/.test(date))) return { ok: false, error: "bad_date" };

  const category = searchParams.get("category");
  if (category !== null && category !== "all" && !categories.includes(category)) return { ok: false, error: "bad_category" };

  return { ok: true, kind, date, category };
}
