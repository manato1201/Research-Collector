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

export const BOARD_LABELS = { reading: "読む", try: "試す", hold: "保留" };
export const BOARD_ORDER = ["reading", "try", "hold"];
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
  EXTRA = [];
  state.status = null;
}
