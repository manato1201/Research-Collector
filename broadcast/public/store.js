// Research Broadcast — カテゴリ・API・共通の状態
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { h } from "./util.js";

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
export const BOARD_ORDER = ["reading", "try", "hold"]; // ボードのページの列(「既読」は列にしない)
export const DRAWER_STATES = ["unread", ...BOARD_ORDER, "read"];
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
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ 状態

export const state = {
  board: new Map(), // url_hash -> {state, note}
  boardLoaded: false,
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
  if (state.boardLoaded && !force) return;
  const data = await api("/api/board");
  state.board = new Map(data.items.map((i) => [i.url_hash, { state: i.state, note: i.note }]));
  state.boardLoaded = true;
}

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
  state.categoriesLoaded = false;
  state.prefs = { watchwords: [], muted_sources: [], projects: [] };
  state.prefsLoaded = false;
  state.insights = new Map();
  EXTRA = [];
  state.status = null;
}
