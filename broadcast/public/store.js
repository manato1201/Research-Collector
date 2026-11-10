// Research Broadcast — カテゴリ・API・共通の状態
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { addDays, h, jstToday } from "./util.js";

export const CATEGORIES = ["game_dev_tech", "graphics_research", "software_engineering"];
export const LABELS = {
  game_dev_tech: "Game-Dev-Tech",
  graphics_research: "Graphics-Research",
  software_engineering: "Software-Engineering",
};
// 追加カテゴリ(任意)。Worker の設定(EXTRA_CATEGORIES)で与えられ、/api/categories で取得する。
// 基本の3つ(CATEGORIES)は episode(日次・週次)の対象。追加分は記事の API から直接出す。
export let EXTRA = []; // [{id, label}]
export const allCategoryIds = () => [...CATEGORIES, ...EXTRA.map((e) => e.id)];

export const BOARD_LABELS = { reading: "読む", try: "試す", hold: "保留", read: "既読" };
// 絞り込みの属性(サーバーの SOURCE_KINDS と、題名の言語判定に対応する)
export const KIND_LABELS = [
  ["official", "公式・更新情報"],
  ["article", "技術記事"],
  ["news", "ゲームニュース"],
  ["talk", "講演資料"],
  ["paper", "論文"],
  ["x", "X 投稿"],
  ["other", "その他"],
];
export const LANG_LABELS = [
  ["ja", "日本語"],
  ["en", "English"],
];
export const BOARD_ORDER = ["reading", "try", "hold"]; // ボードのページの列(「既読」は列にしない)
export const DRAWER_STATES = ["unread", ...BOARD_ORDER, "read"];
// 見直す日の選択肢([キー, 表示, 何日後])
export const REMIND_CHOICES = [
  ["tomorrow", "明日", 1],
  ["3d", "3日後", 3],
  ["week", "1週間後", 7],
];
export const TIDY_DAYS = [7, 14, 30]; // 整理で選べる「何日以上たった未読か」(サーバーの TIDY_BUCKETS と同じ)
export const STALE_HOURS = 20; // 12時間おきの実行。これを超えて取り込みが無ければ「止まっている可能性」と出す

export function catLabel(c) {
  return LABELS[c] ?? c;
}
export function dot(cat) {
  // 基本の3つは固定色。追加分は、順番で x1〜x4 の色(丸 + 文字で区別する。色だけにしない)
  const i = EXTRA.findIndex((e) => e.id === cat);
  const cls = CATEGORIES.includes(cat) ? cat : i >= 0 ? `x${(i % 4) + 1}` : "";
  return h("span", { class: `dot ${cls}`, "aria-hidden": "true" });
}


// ------------------------------------------------------------------ API

export class AuthError extends Error {}

export async function api(path, { method = "GET", body } = {}) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) throw new AuthError("unauthorized");
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 本文なし */
  }
  // Cloudflare Access を通っても、許可リスト(ACCESS_ALLOWED_EMAILS)に無い人
  if (res.status === 403 && data?.error === "forbidden") {
    throw new Error("このアカウントには、このサイトの利用が許可されていません。管理者に依頼してください");
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ 状態

export const state = {
  board: new Map(), // url_hash -> {state, note}
  boardLoaded: false,
  marks: new Map(), // url_hash -> {pinned, remind_on}(ピンと見直す日。ボードの状態とは別)
  markList: [], // /api/marks の items(記事つき。ホーム・ボードの「見直し」で使う)
  marksLoaded: false,
  categoriesLoaded: false,
  prefs: { watchwords: [], muted_sources: [], projects: [] },
  prefsLoaded: false,
  insights: new Map(), // url_hash -> {what, use, apply, source}
  session: { authenticated: false, via: null, login_enabled: false },
  status: null,
  statusAt: 0,
};
export const cleanup = []; // ページを離れるときに片付ける処理(IntersectionObserver・読み上げ)

export async function loadBoard(force = false) {
  const fetching = state.boardLoaded && !force ? null : api("/api/board");
  const [data] = await Promise.all([fetching, loadMarks(force)]);
  if (!data) return;
  state.board = new Map(data.items.map((i) => [i.url_hash, { state: i.state, note: i.note }]));
  state.boardLoaded = true;
}

/** ピンと見直す日。読めなくても(移行前・一時的な障害)、ほかの画面は動かす。認証切れだけは伝える。 */
export async function loadMarks(force = false) {
  if (state.marksLoaded && !force) return;
  try {
    setMarkList((await api("/api/marks")).items ?? []);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    setMarkList([]);
  }
  state.marksLoaded = true;
}

export function setMarkList(items) {
  state.markList = items;
  state.marks = new Map(items.map((i) => [i.url_hash, { pinned: i.pinned, remind_on: i.remind_on }]));
}

/** 1件の目印を、画面の状態に反映する(どちらも無ければ消す)。記事を渡すと、一覧(markList)にも入れる。 */
export function applyMark(hash, mark, article = null) {
  const has = Boolean(mark?.pinned || mark?.remind_on);
  state.markList = state.markList.filter((i) => i.url_hash !== hash);
  if (!has) {
    state.marks.delete(hash);
    return;
  }
  state.marks.set(hash, { pinned: Boolean(mark.pinned), remind_on: mark.remind_on ?? null });
  if (article) state.markList.unshift({ url_hash: hash, pinned: Boolean(mark.pinned), remind_on: mark.remind_on ?? null, article });
}

/** 見直す日が、今日かそれより前(=見直しの時期)か。 */
export const isDue = (mark) => Boolean(mark?.remind_on) && mark.remind_on <= jstToday();

/** n 日後の日付(JST)。 */
export const remindDate = (n) => addDays(jstToday(), n);

export async function loadCategories() {
  if (state.categoriesLoaded) return;
  const res = await api("/api/categories");
  EXTRA = res.extra ?? [];
  for (const e of EXTRA) LABELS[e.id] = e.label;
  state.categoriesLoaded = true;
}

/** 設定(ウォッチワード・非表示の収集元・関連プロジェクト)。 */
export async function loadPrefs(force = false) {
  if (state.prefsLoaded && !force) return;
  const p = await api("/api/prefs");
  state.prefs = {
    watchwords: p.watchwords ?? [],
    muted_sources: p.muted_sources ?? [],
    projects: p.projects ?? [],
  };
  state.prefsLoaded = true;
}

export async function savePref(key, value) {
  const res = await api(`/api/prefs/${key}`, { method: "PUT", body: { value } });
  state.prefs = { ...state.prefs, [key]: res.value };
  return res.value;
}

export const isMuted = (platform) => state.prefs.muted_sources.includes(platform);

/** 非表示の収集元を除いた記事。 */
export const unmuted = (articles) => articles.filter((a) => !isMuted(a.platform));

/** API の問い合わせに足す、非表示の収集元(exclude_platforms)。 */
export function excludeParam() {
  const m = state.prefs.muted_sources;
  return m.length ? `&exclude_platforms=${encodeURIComponent(m.join(","))}` : "";
}

/** 記事に当てはまる関連プロジェクトの名前(題名・要約・キーワードに、プロジェクトのキーワードが含まれる)。 */
export function projectsFor(a) {
  const hay = `${a.title ?? ""} ${a.summary ?? ""} ${(a.keywords ?? []).join(" ")}`.toLowerCase();
  return state.prefs.projects
    .filter((p) => p.keywords.some((k) => hay.includes(k.toLowerCase())))
    .map((p) => p.name);
}

// 「既読を隠す」(この端末だけの設定)
const HIDE_READ_KEY = "rb-hide-read";
export function getHideRead() {
  try {
    return localStorage.getItem(HIDE_READ_KEY) === "1";
  } catch {
    return false;
  }
}
export function setHideRead(on) {
  document.body.dataset.hideRead = on ? "1" : "0";
  try {
    localStorage.setItem(HIDE_READ_KEY, on ? "1" : "0");
  } catch {
    /* 保存できなくても動く */
  }
}

/**
 * 記事の解説(これは何か / 何ができるか / どう応用できるか)。AI が題名と要約から書いたもの(source = "ai")か、
 * 無ければ出典の種類ごとの定型の解説(source = "rule")。取得済みのものは再取得しない。
 * @returns {Promise<Map<string, object>>} state.insights
 */
export async function loadInsights(hashes) {
  const need = [...new Set(hashes)].filter((h) => h && !state.insights.has(h));
  for (let i = 0; i < need.length; i += 60) {
    const chunk = need.slice(i, i + 60);
    const res = await api(`/api/insights?hashes=${chunk.join(",")}`);
    for (const [h, v] of Object.entries(res.insights ?? {})) state.insights.set(h, v);
  }
  return state.insights;
}

export async function loadStatus(force = false) {
  if (!force && state.status && Date.now() - state.statusAt < 60_000) return state.status;
  state.status = await api("/api/status");
  state.statusAt = Date.now();
  return state.status;
}


/** ログアウト時に、人ごとの状態を捨てる。 */
export function resetSessionState() {
  state.session = { ...state.session, authenticated: false, via: null };
  state.board = new Map();
  state.boardLoaded = false;
  state.marks = new Map();
  state.markList = [];
  state.marksLoaded = false;
  state.categoriesLoaded = false;
  state.prefs = { watchwords: [], muted_sources: [], projects: [] };
  state.prefsLoaded = false;
  state.insights = new Map();
  EXTRA = [];
  state.status = null;
}
