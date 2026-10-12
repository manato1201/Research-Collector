// Research Broadcast — サイト本体(依存なしの SPA)
//
// 方針:
//  - データは同一オリジンの /api/* から取る。HTML 文字列を組み立てない(DOM + textContent のみ)。
//  - リンク先は http(s) だけ許可する(記事の URL は外部入力なので javascript: 等を弾く)。
//  - 動きは「カウントアップ」と「フェードイン」の2種類だけ。prefers-reduced-motion では止める。
//  - 読み上げはブラウザの speechSynthesis(無料。声は端末による)。再生バーと章の送りは player.js。
//  - レポート(Markdown)は markdown.js で、DOM + textContent だけで描画する。
//  - 認証: 401 が返ったらログイン画面へ。ボードの書き込みは Cookie + Origin 検査(Worker 側)。

import { markdownToSpeech, renderMarkdown } from "./markdown.js";
import * as player from "./player.js";

const CATEGORIES = ["game_dev_tech", "graphics_research", "software_engineering"];
const LABELS = {
  game_dev_tech: "Game-Dev-Tech",
  graphics_research: "Graphics-Research",
  software_engineering: "Software-Engineering",
};
// 追加カテゴリ(任意)。Worker の設定(EXTRA_CATEGORIES)で与えられ、/api/categories で取得する。
// 基本の3つ(CATEGORIES)は episode(日次・週次)の対象。追加分は記事の API から直接出す。
let EXTRA = []; // [{id, label}]
const allCategoryIds = () => [...CATEGORIES, ...EXTRA.map((e) => e.id)];

const BOARD_LABELS = { reading: "読む", try: "試す", hold: "保留" };
const BOARD_ORDER = ["reading", "try", "hold"];
const STALE_HOURS = 20; // 12時間おきの実行。これを超えて取り込みが無ければ「止まっている可能性」と出す
const HOME_LANE_ITEMS = 8;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ 小さな道具

/** DOM を作る。children は文字列(textContent)か Node。属性は class / dataset / on* / その他。 */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "href") el.setAttribute("href", safeHref(v));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** http(s) か、サイト内の相対パスだけ通す。それ以外は "#" にする。 */
function safeHref(v) {
  const s = String(v);
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") return u.href;
  } catch {
    /* fallthrough */
  }
  return "#";
}

const pad2 = (n) => String(n).padStart(2, "0");
const jstNow = () => new Date(Date.now() + 9 * 3600_000);
const ymd = (d) => d.toISOString().slice(0, 10);

function jstToday() {
  return ymd(jstNow());
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 月=0
  return addDays(day, -dow);
}

function formatDateTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "不明";
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
function relativeTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (min < 60) return `${min}分前`;
  if (min < 60 * 48) return `${Math.round(min / 60)}時間前`;
  return `${Math.round(min / 1440)}日前`;
}
const shortDate = (s) => (s && s.length >= 10 ? s.slice(5, 10) : "");

function catLabel(c) {
  return LABELS[c] ?? c;
}
function dot(cat) {
  // 基本の3つは固定色。追加分は、順番で x1〜x4 の色(丸 + 文字で区別する。色だけにしない)
  const i = EXTRA.findIndex((e) => e.id === cat);
  const cls = CATEGORIES.includes(cat) ? cat : i >= 0 ? `x${(i % 4) + 1}` : "";
  return h("span", { class: `dot ${cls}`, "aria-hidden": "true" });
}

function toast(message, isError = false) {
  const box = document.getElementById("toasts");
  const el = h("div", { class: `toast${isError ? " err" : ""}`, role: isError ? "alert" : "status" }, message);
  box.append(el);
  setTimeout(() => el.remove(), 3800);
}

function countUp(root) {
  for (const el of root.querySelectorAll("[data-count]")) {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) continue;
    if (reduceMotion || target < 2) {
      el.textContent = String(target);
      continue;
    }
    const start = performance.now();
    const duration = 650;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function fadeIn(nodes) {
  if (reduceMotion) return;
  nodes.forEach((n, i) => {
    n.classList.add("fade");
    n.style.animationDelay = `${Math.min(i, 8) * 60}ms`; // CSSOM 経由(CSP の style 属性禁止に当たらない)
  });
}

// ------------------------------------------------------------------ API

class AuthError extends Error {}

async function api(path, { method = "GET", body } = {}) {
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

const state = {
  board: new Map(), // url_hash -> {state, note}
  boardLoaded: false,
  categoriesLoaded: false,
  session: { authenticated: false, via: null, login_enabled: false },
  status: null,
  statusAt: 0,
};
let cleanup = []; // ページを離れるときに片付ける処理(IntersectionObserver・読み上げ)

async function loadBoard(force = false) {
  if (state.boardLoaded && !force) return;
  const data = await api("/api/board");
  state.board = new Map(data.items.map((i) => [i.url_hash, { state: i.state, note: i.note }]));
  state.boardLoaded = true;
}

async function loadCategories() {
  if (state.categoriesLoaded) return;
  const res = await api("/api/categories");
  EXTRA = res.extra ?? [];
  for (const e of EXTRA) LABELS[e.id] = e.label;
  state.categoriesLoaded = true;
}

async function loadStatus(force = false) {
  if (!force && state.status && Date.now() - state.statusAt < 60_000) return state.status;
  state.status = await api("/api/status");
  state.statusAt = Date.now();
  return state.status;
}

// ------------------------------------------------------------------ 共通の部品

const isNewToday = (a) => (a.collected_at ?? "").slice(0, 10) === jstToday();

function renderItem(a, { showCategoryBadge = true } = {}) {
  const cats = a.categories ?? [];
  const others = a.other_categories ?? [];
  const board = state.board.get(a.url_hash);

  const meta = h("div", { class: "item-meta" });
  if (a.platform) meta.append(h("span", { class: "badge" }, a.platform));
  if (showCategoryBadge && others.length) {
    meta.append(
      h(
        "span",
        { class: "badge", title: "この記事は、ほかのカテゴリのレーンにも出ています(件数は重複して数えません)" },
        `ほかのカテゴリにも: ${others.map(catLabel).join(" / ")}`,
      ),
    );
  }
  if (a.review) meta.append(h("span", { class: "badge warn", title: "分類に自信がありません。人の確認が必要です" }, "要確認"));
  if (board) meta.append(h("span", { class: "badge state", title: "ボードに入れた状態" }, BOARD_LABELS[board.state] ?? board.state));

  const li = h(
    "li",
    { class: "item", dataset: { hash: a.url_hash } },
    h("button", { class: "item-title", type: "button", onclick: () => openDrawer(a) }, a.title),
    h("time", { class: "item-date mono" }, shortDate(a.published ?? a.collected_at ?? "")),
    meta,
  );
  if (a.summary) li.append(h("p", { class: "item-sum" }, a.summary));
  return li;
}

function renderEmpty(title, text) {
  return h("div", { class: "empty" }, h("b", null, title), h("span", null, text));
}

function renderSkeleton() {
  return h(
    "div",
    { "aria-hidden": "true" },
    h("div", { class: "skeleton" }),
    h("div", { class: "skeleton" }),
    h("div", { class: "skeleton" }),
    h("div", { class: "skeleton" }),
  );
}

function sourceChips(sources, active, onPick) {
  const wrap = h("div", { class: "source-chips", role: "group", "aria-label": "収集元で絞り込む" });
  const all = (sources ?? []).reduce((s, x) => s + x.count, 0);
  const make = (label, key, n) =>
    h(
      "button",
      { class: "chip", type: "button", "aria-pressed": String(active === key), onclick: () => onPick(key) },
      label,
      h("span", { class: "n" }, String(n)),
    );
  wrap.append(make("すべて", null, all));
  for (const s of sources ?? []) wrap.append(make(s.platform, s.platform, s.count));
  return wrap;
}

// ------------------------------------------------------------------ ドロワー(記事の詳細・ボード操作)

let drawerReturnFocus = null;
const inertTargets = () => [document.getElementById("view"), document.querySelector(".top"), document.querySelector(".foot")];

function openDrawer(article) {
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  document.getElementById("drawer-title").textContent = article.title;
  const body = document.getElementById("drawer-body");
  body.replaceChildren(buildDrawerBody(article));

  drawerReturnFocus = document.activeElement;
  drawer.hidden = false;
  backdrop.hidden = false;
  inertTargets().forEach((el) => el?.setAttribute("inert", ""));
  document.getElementById("drawer-close").focus();
}

function closeDrawer() {
  const drawer = document.getElementById("drawer");
  if (drawer.hidden) return;
  drawer.hidden = true;
  document.getElementById("drawer-backdrop").hidden = true;
  inertTargets().forEach((el) => el?.removeAttribute("inert"));
  if (drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus();
  drawerReturnFocus = null;
}

function buildDrawerBody(a) {
  const wrap = h("div", { class: "drawer-body-inner" });
  const cats = a.categories ?? [];
  const dl = h("dl", null);
  const row = (k, ...v) => {
    dl.append(h("dt", null, k), h("dd", null, ...v));
  };
  row("収集元", a.platform || "不明");
  if (cats.length) row("カテゴリ", ...cats.map((c) => h("span", { class: "badge" }, dot(c), " ", catLabel(c))));
  row("公開日", h("time", { class: "mono" }, a.published ?? "不明"));
  if (a.collected_at) row("収集", h("time", { class: "mono" }, formatDateTime(a.collected_at)));
  if (a.keywords?.length) row("キーワード", a.keywords.join(" / "));
  if (a.review) row("確認", h("span", { class: "badge warn" }, "分類に自信がありません(要確認)"));

  const sum = a.summary ? h("p", { class: "drawer-sum" }, a.summary) : null;
  const open = h(
    "a",
    { class: "btn primary", href: a.url ?? "#", target: "_blank", rel: "noopener noreferrer" },
    "記事を開く",
  );

  const stateBox = h("div", { class: "board-state", role: "group", "aria-label": "ボードに入れる" });
  const noteInput = h("input", {
    type: "text",
    maxlength: "200",
    placeholder: "メモ(任意・200字まで)",
    "aria-label": "メモ",
    class: "note-input",
  });
  const current = state.board.get(a.url_hash);
  if (current?.note) noteInput.value = current.note;

  const refresh = () => {
    const now = state.board.get(a.url_hash)?.state ?? "unread";
    stateBox.replaceChildren(
      ...["unread", ...BOARD_ORDER].map((s) =>
        h(
          "button",
          {
            class: "chip",
            type: "button",
            "aria-pressed": String(now === s),
            onclick: () => setBoard(a, s, noteInput.value, refresh),
          },
          s === "unread" ? "未読" : BOARD_LABELS[s],
        ),
      ),
    );
  };
  refresh();

  wrap.append(dl);
  if (sum) wrap.append(sum);
  const readOne = readButton("この記事を読み上げ", a.title, () => [{ label: "記事", text: `${a.title}。${a.summary ?? ""}` }]);
  wrap.append(h("div", { class: "drawer-actions" }, open, readOne), stateBox, noteInput);
  return wrap;
}

async function setBoard(article, newState, note, rerender) {
  try {
    if (newState === "unread") {
      await api(`/api/board/${article.url_hash}`, { method: "DELETE" });
      state.board.delete(article.url_hash);
    } else {
      await api(`/api/board/${article.url_hash}`, { method: "PUT", body: { state: newState, note: note.trim() } });
      state.board.set(article.url_hash, { state: newState, note: note.trim() });
    }
    rerender();
    toast(newState === "unread" ? "未読に戻しました" : `「${BOARD_LABELS[newState]}」に入れました`);
    refreshItemBadges(article.url_hash);
  } catch (err) {
    if (err instanceof AuthError) return navigate("/login");
    toast("ボードを更新できませんでした。時間をおいてやり直してください", true);
  }
}

/** 一覧に出ている同じ記事の「ボード」バッジだけを更新する(一覧を描き直さない)。 */
function refreshItemBadges(hash) {
  const board = state.board.get(hash);
  for (const li of document.querySelectorAll(`#view .item[data-hash="${hash}"]`)) {
    li.querySelector(".badge.state")?.remove();
    if (board) li.querySelector(".item-meta")?.append(h("span", { class: "badge state" }, BOARD_LABELS[board.state]));
  }
}

// ------------------------------------------------------------------ ステータスバー(ヘッダ)

async function renderStatusBar() {
  const bar = document.getElementById("status-bar");
  try {
    const s = await loadStatus();
    const parts = [];
    if (s.last_success_at) {
      const stale = Date.now() - Date.parse(s.last_success_at) > STALE_HOURS * 3600_000;
      parts.push(
        "最終更新 ",
        h("b", { class: stale ? "warn" : "" }, relativeTime(s.last_success_at)),
        stale ? h("span", { class: "badge warn" }, "取り込みが止まっている可能性") : null,
      );
    } else {
      parts.push("まだ取り込みがありません");
    }
    parts.push(" ・ 記事 ", h("b", null, String(s.articles.total)), "件");
    if (s.failures.length) parts.push(" ・ 取得に失敗した収集元 ", h("b", { class: "warn" }, String(s.failures.length)));
    bar.replaceChildren(...parts.filter(Boolean));
  } catch (err) {
    bar.replaceChildren();
  }
}

/** パンくず。最後の1つは現在のページ(リンクにしない)。区切りは読み上げに含めない。 */
function crumbs(...parts) {
  const nav = h("nav", { class: "crumbs", "aria-label": "パンくず" });
  parts.forEach((part, i) => {
    if (i > 0) nav.append(h("span", { "aria-hidden": "true" }, "›"));
    const last = i === parts.length - 1;
    nav.append(typeof part === "string" ? h("span", { "aria-current": last ? "page" : null }, part) : part);
  });
  return nav;
}

// ------------------------------------------------------------------ 読み上げ(ブラウザの音声。再生バーは player.js)

const itemText = (a) => `${a.title}。${a.summary ?? ""}`.trim();
const chapterLabel = (a, i) => `${i + 1}. ${String(a.title).slice(0, 36)}`;
const itemsToChapters = (items, n = 10) =>
  items.slice(0, n).map((a, i) => ({ label: chapterLabel(a, i), text: itemText(a) }));

/**
 * 読み上げのボタン。押すと再生バーが出て、章ごとにスキップできる。
 * build は押したときに呼ぶ(読み上げる内容を、その時点の表示から作る)。
 * 読み上げに対応していないブラウザでは、無効にして理由を出す。
 */
function readButton(label, title, build) {
  if (!player.supported) {
    return h(
      "button",
      { class: "btn read-btn", type: "button", disabled: true, title: "このブラウザは読み上げに対応していません" },
      label,
    );
  }
  const btn = h(
    "button",
    {
      class: "btn read-btn",
      type: "button",
      "aria-pressed": "false",
      dataset: { readTitle: title, readLabel: label },
      onclick: () => {
        const s = player.snapshot();
        if (s.status !== "idle" && s.title === title) {
          player.stop();
          return;
        }
        const payload = build();
        if (!player.read({ title, chapters: payload })) toast("読み上げる内容がありません", true);
      },
    },
    label,
  );
  return btn;
}

// 再生状態に合わせて、ボタンの「停止 / 読み上げ」を切り替える
player.onChange((s) => {
  document.querySelectorAll("[data-read-title]").forEach((b) => {
    const on = s.status !== "idle" && s.title === b.dataset.readTitle;
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? "停止" : b.dataset.readLabel;
  });
});

// ------------------------------------------------------------------ 共通: 目次の現在位置・速報

function attachScrollSpy(toc, ids) {
  const links = new Map([...toc.querySelectorAll("a")].map((a) => [a.dataset.anchor, a]));
  const obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.removeAttribute("aria-current"));
        links.get(e.target.id)?.setAttribute("aria-current", "true");
      }
    },
    { rootMargin: "-20% 0px -70% 0px" },
  );
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) obs.observe(el);
  });
  cleanup.push(() => obs.disconnect());
}

/** 速報ティッカー。ゆっくり流れる。停止ボタンがあり、ホバー・フォーカス中も止まる。reduced-motion では流れない。 */
function buildTicker(items) {
  if (!items.length) return null;
  const mkSet = (dup) =>
    h(
      "div",
      { class: `ticker-set${dup ? " ticker-dup" : ""}`, "aria-hidden": dup ? "true" : null },
      ...items.map((a) =>
        h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer", tabindex: dup ? "-1" : null }, a.title),
      ),
    );
  const track = h("div", { class: "ticker-track" }, mkSet(false), mkSet(true));
  const chars = items.reduce((n, a) => n + String(a.title).length, 0);
  track.style.animationDuration = `${Math.max(40, Math.round(chars * 0.45))}s`;

  const toggle = h(
    "button",
    {
      class: "icon-btn ticker-toggle",
      type: "button",
      "aria-pressed": "false",
      onclick: (ev) => {
        const paused = ticker.dataset.paused !== "true";
        ticker.dataset.paused = String(paused);
        ev.currentTarget.setAttribute("aria-pressed", String(paused));
        ev.currentTarget.textContent = paused ? "再生" : "停止";
      },
    },
    "停止",
  );
  const ticker = h(
    "div",
    { class: "ticker", role: "region", "aria-label": "速報", dataset: { paused: "false" } },
    h("span", { class: "ticker-label" }, "速報"),
    h("div", { class: "ticker-view" }, track),
    toggle,
  );
  return ticker;
}

// ------------------------------------------------------------------ ページ: 今日の放送

async function pageHome(view, params) {
  view.replaceChildren(renderSkeleton());
  const wanted = params.get("d");
  const dateQuery = wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : "latest";
  const [{ date, episodes }, datesRes, watch, status, extraLanes] = await Promise.all([
    api(`/api/episodes?kind=daily&date=${dateQuery}`),
    api("/api/episodes/dates?kind=daily"),
    api("/api/watch").catch((e) => (e instanceof AuthError ? Promise.reject(e) : { items: [] })),
    loadStatus().catch(() => null),
    // 追加カテゴリは、直近7日に収集した記事を API から直接取る(episode は基本の3つだけ)
    Promise.all(
      EXTRA.map(async (e) => {
        const res = await api(
          `/api/articles?category=${e.id}&status=added&collected_since=${addDays(jstToday(), -6)}&limit=8`,
        );
        return { ...e, total: res.total, items: res.articles.map((a) => ({ ...a, other_categories: [] })) };
      }),
    ),
    loadBoard(),
  ]);

  const all = episodes.find((e) => e.category === null);
  const lanes = Object.fromEntries(episodes.filter((e) => e.category).map((e) => [e.category, e]));

  if (!date || !all) {
    view.replaceChildren(
      h("h1", null, "今日の", h("em", null, "放送")),
      renderEmpty("まだ放送がありません", "収集が実行されると、ここに今日の新着が並びます。"),
    );
    return;
  }

  const counts = all.data.counts;
  const stat = (n, label, cls) =>
    h(
      "div",
      { class: "stat" },
      h("span", { class: `stat-num ${cls ?? ""}` }, h("span", { class: "num", "data-count": String(n) }, "0"), h("small", null, "件")),
      h("span", { class: "stat-label" }, label),
    );

  const dateSelect = h(
    "select",
    { class: "btn", "aria-label": "日付を選ぶ", onchange: (ev) => navigate(`/?d=${ev.target.value}`) },
    ...datesRes.dates.map((d) => h("option", { value: d, selected: d === date }, d)),
  );

  // 全体の読み上げ: 見出し → カテゴリごとの章(件数と上位の記事)
  const readAll = readButton("全体を読み上げ", `${date} の放送`, () => [
    { label: "見出し", text: all.headline },
    ...CATEGORIES.filter((c) => lanes[c]).map((c) => ({
      label: catLabel(c),
      text: `${catLabel(c)}、${lanes[c].data.count}件。` + lanes[c].data.items.slice(0, 5).map(itemText).join(" "),
    })),
  ]);

  const picker = h("div", { class: "lane-picker", role: "group", "aria-label": "カテゴリを選ぶ" });
  let mobileCat = CATEGORIES.find((c) => lanes[c]) ?? CATEGORIES[0];
  const laneEls = {};
  const applyMobile = () => {
    for (const c of CATEGORIES) laneEls[c].dataset.hiddenMobile = String(c !== mobileCat);
    for (const b of picker.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.cat === mobileCat));
  };

  for (const c of CATEGORIES) {
    const ep = lanes[c];
    const items = ep?.data.items ?? [];
    const lane = h(
      "section",
      { class: "lane", "aria-labelledby": `lane-${c}` },
      h("div", { class: "lane-head" }, dot(c), h("h2", { id: `lane-${c}` }, catLabel(c)), h("span", { class: "lane-count num" }, String(ep?.data.count ?? 0))),
    );
    if (ep) {
      lane.append(h("p", { class: "lane-headline" }, ep.headline.replace(/^[^:]+: /, "")));
      lane.append(h("ul", { class: "list" }, ...items.slice(0, HOME_LANE_ITEMS).map((a) => renderItem(a))));
      lane.append(
        h(
          "div",
          { class: "lane-foot" },
          readButton("このカテゴリを読み上げ", `${catLabel(c)} の新着(${date})`, () => itemsToChapters(items)),
          h("a", { class: "btn", href: `/c/${c}`, "data-link": "" }, `すべて見る(${ep.data.count}件)`),
        ),
      );
    } else {
      lane.append(h("p", { class: "lane-headline" }, "この日の新着はありません"));
    }
    laneEls[c] = lane;
    picker.append(
      h("button", { class: "chip", type: "button", "data-cat": c, onclick: () => { mobileCat = c; applyMobile(); } }, catLabel(c)),
    );
  }

  const highlights = all.data.highlights ?? [];
  const hl = highlights.length
    ? h(
        "section",
        { class: "panel", "aria-labelledby": "hl-title" },
        h("h2", { id: "hl-title" }, "注目"),
        h("ul", { class: "list" }, ...highlights.map((a) => renderItem(a, { showCategoryBadge: false }))),
      )
    : null;

  // 速報: 注目 + 各カテゴリの先頭(重複は除く)
  const tickerItems = [];
  const seen = new Set();
  for (const a of [...highlights, ...CATEGORIES.flatMap((c) => (lanes[c]?.data.items ?? []).slice(0, 3))]) {
    if (!seen.has(a.url_hash)) {
      seen.add(a.url_hash);
      tickerItems.push(a);
    }
  }

  const latestReport = status?.reports?.latest;
  const reportLink = latestReport
    ? h("a", { class: "btn", href: `/reports/${encodeURIComponent(`digest:${latestReport}`)}`, "data-link": "" }, `最新のレポート(${latestReport})`)
    : null;

  const watchItems = watch.items ?? [];
  const watchBox = watchItems.length
    ? h(
        "details",
        { class: "acc watch-list" },
        h("summary", null, `配布サイトの新着(通知のみ) ${watchItems.length}件`),
        h("p", { class: "tool-note", style: null }, "導入はしません。中身を確認してから判断してください。"),
        h(
          "ul",
          null,
          ...watchItems.map((w) =>
            h(
              "li",
              null,
              h("time", { class: "mono" }, shortDate(w.detected_at)),
              h("a", { href: w.url, target: "_blank", rel: "noopener noreferrer" }, w.title),
              h("span", { class: "badge" }, w.watch),
            ),
          ),
        ),
      )
    : null;

  view.replaceChildren(
    h(
      "div",
      { class: "hero" },
      h("div", null, h("h1", null, "今日の", h("em", null, "放送")), h("p", { class: "sub" }, h("time", { class: "mono" }, date), " ・ ", all.headline)),
      h("div", { class: "stats" }, stat(counts.total, "新着(URL単位)", "new"), stat(counts.review, "要確認")),
    ),
    buildTicker(tickerItems),
    h("div", { class: "row-controls" }, dateSelect, readAll, reportLink),
    hl,
    picker,
    h("div", { class: "lanes" }, ...CATEGORIES.map((c) => laneEls[c])),
    extraLanes.length ? buildExtraLanes(extraLanes) : null,
    watchBox,
  );
  applyMobile();
  countUp(view); // トップの動きは「カウントアップ」と「速報の流れ」の2種類(フェードインは使わない)
}

/** 追加カテゴリのレーン(直近7日に収集した記事)。基本の3レーンの下に、別の見出しで出す。 */
function buildExtraLanes(lanes) {
  const box = h(
    "section",
    { class: "extra-lanes", "aria-labelledby": "extra-title" },
    h("h2", { id: "extra-title", class: "extra-title" }, "追加の分野(直近7日に収集)"),
  );
  const grid = h("div", { class: "lanes" });
  for (const l of lanes) {
    const lane = h(
      "section",
      { class: "lane", "aria-labelledby": `lane-${l.id}` },
      h("div", { class: "lane-head" }, dot(l.id), h("h2", { id: `lane-${l.id}` }, l.label), h("span", { class: "lane-count num" }, String(l.total))),
    );
    if (l.items.length) {
      lane.append(h("ul", { class: "list" }, ...l.items.map((a) => renderItem(a, { showCategoryBadge: false }))));
      lane.append(
        h(
          "div",
          { class: "lane-foot" },
          readButton("このカテゴリを読み上げ", `${l.label}(直近7日)`, () => itemsToChapters(l.items)),
          h("a", { class: "btn", href: `/c/${l.id}`, "data-link": "" }, `すべて見る(${l.total}件)`),
        ),
      );
    } else {
      lane.append(h("p", { class: "lane-headline" }, "直近7日の新着はありません"));
    }
    grid.append(lane);
  }
  box.append(grid);
  return box;
}

// ------------------------------------------------------------------ ページ: カテゴリ

function previousMonthRange(today) {
  const [y, m] = today.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return { since: ymd(first), until: ymd(last) };
}

const PERIODS = [
  ["today", "今日"],
  ["week", "今週"],
  ["30d", "30日"],
  ["month", "先月"],
];

async function pageCategory(view, cat, params) {
  if (!allCategoryIds().includes(cat)) return pageNotFound(view);
  const period = PERIODS.some(([k]) => k === params.get("p")) ? params.get("p") : "week";
  const source = params.get("s");
  const onlyReview = params.get("r") === "1";

  const today = jstToday();
  let since;
  let until = null;
  if (period === "today") since = today;
  else if (period === "week") since = weekStart(today);
  else if (period === "30d") since = addDays(today, -29);
  else ({ since, until } = previousMonthRange(today));

  view.replaceChildren(renderSkeleton());
  const q = `category=${cat}&status=added&since=${since}${until ? `&until=${until}` : ""}&limit=200`;
  const [res, headlineRes] = await Promise.all([
    api(`/api/articles?${q}`),
    api(`/api/episodes?kind=daily&date=latest&category=${cat}`).catch((e) => (e instanceof AuthError ? Promise.reject(e) : null)),
    loadBoard(),
  ]);
  const headline = headlineRes?.episodes?.[0]?.headline ?? null;

  const articles = res.articles.map((a) => ({ ...a, other_categories: a.categories.filter((c) => c !== cat) }));
  const sourceCount = new Map();
  for (const a of articles) sourceCount.set(a.platform, (sourceCount.get(a.platform) ?? 0) + 1);
  const sources = [...sourceCount].map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count);

  const go = (patch) => {
    const qs = new URLSearchParams({ p: period, ...(source ? { s: source } : {}), ...(onlyReview ? { r: "1" } : {}) });
    for (const [k, v] of Object.entries(patch)) (v === null ? qs.delete(k) : qs.set(k, v));
    navigate(`/c/${cat}?${qs}`);
  };

  const shown = articles.filter((a) => (!source || a.platform === source) && (!onlyReview || a.review));
  const seg = h(
    "div",
    { class: "seg", role: "group", "aria-label": "期間" },
    ...PERIODS.map(([k, label]) =>
      h("button", { type: "button", "aria-pressed": String(period === k), onclick: () => go({ p: k }) }, label),
    ),
  );
  const reviewChip = h(
    "button",
    { class: "chip", type: "button", "aria-pressed": String(onlyReview), onclick: () => go({ r: onlyReview ? null : "1" }) },
    "要確認のみ",
  );
  const periodLabel = PERIODS.find(([k]) => k === period)[1];
  const readThis = readButton("このページを読み上げ", `${catLabel(cat)}(${periodLabel})`, () => itemsToChapters(shown, 20));

  const list = shown.length
    ? h("ul", { class: "list" }, ...shown.map((a) => renderItem(a)))
    : renderEmpty("該当する記事がありません", "期間や絞り込みを変えてみてください。");

  view.replaceChildren(
    crumbs(h("a", { href: "/", "data-link": "" }, "放送"), catLabel(cat)),
    h("h1", null, dot(cat), " ", catLabel(cat)),
    headline ? h("p", { class: "sub" }, "今日のヘッドライン: ", headline.replace(/^[^:]+: /, "")) : null,
    h("p", { class: "sub" }, `${since}${until ? ` 〜 ${until}` : " 〜"} ・ `, h("span", { class: "num" }, String(shown.length)), "件を表示"),
    // カテゴリの切り替え・絞り込みは、スクロールしても上に固定する(スティッキー)
    h(
      "div",
      { class: "sticky-controls" },
      h("div", { class: "row-controls" }, seg, reviewChip, readThis),
      sourceChips(sources, source, (key) => go({ s: key })),
    ),
    list,
    res.total > res.articles.length
      ? h("p", { class: "fig-note" }, `ほか ${res.total - res.articles.length} 件あります(新しい順に最大200件まで表示)`)
      : null,
  );
  fadeIn([...view.querySelectorAll(".item")].slice(0, 10));
}

// ------------------------------------------------------------------ ページ: ボード

async function pageBoard(view, params) {
  view.replaceChildren(renderSkeleton());
  const data = await api("/api/board");
  state.board = new Map(data.items.map((i) => [i.url_hash, { state: i.state, note: i.note }]));
  state.boardLoaded = true;

  const catFilter = allCategoryIds().includes(params.get("c")) ? params.get("c") : null;
  const visible = data.items.filter((it) => !catFilter || (it.article?.categories ?? []).includes(catFilter));

  const by = { reading: [], try: [], hold: [] };
  for (const it of visible) (by[it.state] ?? []).push(it);

  const lane = (s) => {
    const items = by[s];
    const box = h(
      "section",
      { class: "lane", "aria-labelledby": `board-${s}` },
      h("div", { class: "lane-head" }, h("h2", { id: `board-${s}` }, BOARD_LABELS[s]), h("span", { class: "lane-count num" }, String(items.length))),
    );
    if (!items.length) {
      box.append(h("p", { class: "lane-headline" }, "まだありません"));
      return box;
    }
    const list = h("ul", { class: "list" });
    for (const it of items) {
      const a = it.article
        ? { ...it.article, url_hash: it.url_hash, other_categories: [] }
        : { url_hash: it.url_hash, url: "#", title: "(記事は保持期間を過ぎて削除されました)", categories: [] };
      const li = renderItem(a, { showCategoryBadge: false });
      if (it.note) li.append(h("p", { class: "item-sum" }, `メモ: ${it.note}`));
      if (!it.article) li.querySelector(".item-title").disabled = true;
      list.append(li);
    }
    box.append(list);
    return box;
  };

  const chip = (label, key) =>
    h(
      "button",
      {
        class: "chip",
        type: "button",
        "aria-pressed": String(catFilter === key),
        onclick: () => navigate(key ? `/board?c=${key}` : "/board"),
      },
      label,
    );

  view.replaceChildren(
    h("h1", null, "ボード"),
    h("p", { class: "sub" }, "記事の詳細で「読む」「試す」「保留」に入れた記事です。保持期間(90日)を過ぎた記事は本文が消えます。"),
    h(
      "div",
      { class: "row-controls", role: "group", "aria-label": "カテゴリで絞り込む" },
      chip("すべて", null),
      ...allCategoryIds().map((c) => chip(catLabel(c), c)),
    ),
    h("div", { class: "lanes" }, ...BOARD_ORDER.map(lane)),
  );
  fadeIn([...view.querySelectorAll(".lane")]);
}

// ------------------------------------------------------------------ ページ: 週次特集(図は SVG)

function barChart({ title, rows, note }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fig = h("figure", { class: "fig" }, h("h3", null, title));
  const W = 560, rowH = 30, left = 150, right = 44;
  const H = rows.length * rowH + 6;
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}: ${rows.map((r) => `${r.label} ${r.value}件`).join("、")}` });
  rows.forEach((r, i) => {
    const w = ((W - left - right) * r.value) / max;
    const y = i * rowH + 4;
    chart.append(
      svg("text", { x: 0, y: y + 15 }, r.label),
      svg("rect", { class: `bar ${r.cls ?? "total"}`, x: left, y, width: Math.max(w, r.value ? 1 : 0), height: 20, rx: 3 }),
      svg("text", { class: "val", x: left + w + 6, y: y + 15 }, String(r.value)),
    );
  });
  fig.append(chart);
  if (note) fig.append(h("p", { class: "fig-note" }, note));
  return fig;
}

/** 日別の推移の折れ線。見えたときに、線が引かれる(1回。reduced-motion では最初から全部)。 */
function lineChart({ title, rows, note }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fig = h("figure", { class: "fig" }, h("h3", null, title));
  const W = 560, H = 190, left = 24, right = 24, top = 24, bottom = 28;
  const step = rows.length > 1 ? (W - left - right) / (rows.length - 1) : 0;
  const pts = rows.map((r, i) => ({
    x: left + i * step,
    y: top + (H - top - bottom) * (1 - r.value / max),
    ...r,
  }));
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}: ${rows.map((r) => `${r.label} ${r.value}件`).join("、")}` });
  chart.append(svg("line", { class: "axis", x1: left, x2: W - right, y1: H - bottom, y2: H - bottom }));

  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const path = svg("path", {
    class: "line",
    d: pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" "),
    "stroke-dasharray": String(Math.ceil(len) + 2),
  });
  path.style.setProperty("--len", String(Math.ceil(len) + 2));
  chart.append(path);
  for (const p of pts) {
    chart.append(
      svg("circle", { class: "pt", cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.5 }),
      svg("text", { class: "val", x: p.x.toFixed(1), y: (p.y - 9).toFixed(1), "text-anchor": "middle" }, String(p.value)),
      svg("text", { x: p.x.toFixed(1), y: H - 8, "text-anchor": "middle" }, p.label),
    );
  }
  fig.append(chart);
  if (note) fig.append(h("p", { class: "fig-note" }, note));

  if (!reduceMotion && "IntersectionObserver" in window) {
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        path.classList.add("draw");
        obs.disconnect();
      }
    });
    obs.observe(fig);
    cleanup.push(() => obs.disconnect());
  }
  return fig;
}

async function pageWeekly(view, label) {
  view.replaceChildren(renderSkeleton());
  const [res, datesRes] = await Promise.all([
    api(`/api/episodes?kind=weekly&date=${label ?? "latest"}`),
    api("/api/episodes/dates?kind=weekly"),
    loadBoard(),
  ]);
  const ep = res.episodes.find((e) => e.category === null);
  if (!res.date || !ep) {
    view.replaceChildren(
      h("h1", null, "週次", h("em", null, "特集")),
      renderEmpty("まだ特集がありません", "週の最初のデータが取り込まれると、ここに1週間のまとめが出ます。"),
    );
    return;
  }

  const d = ep.data;
  const weekSelect = h(
    "select",
    { class: "btn", "aria-label": "週を選ぶ", onchange: (ev) => navigate(`/weekly/${ev.target.value}`) },
    ...datesRes.dates.map((w) => h("option", { value: w, selected: w === res.date }, w)),
  );

  const sections = [{ id: "sec-summary", label: "概要" }, { id: "sec-figures", label: "図" }];
  for (const ch of d.chapters) sections.push({ id: `sec-${ch.category}`, label: catLabel(ch.category) });

  const toc = h(
    "nav",
    { class: "toc", "aria-label": "目次" },
    ...sections.map((s) => h("a", { href: `#${s.id}`, "data-anchor": s.id }, s.label)),
  );

  const dayLabel = (day) => `${day.slice(5, 7)}/${day.slice(8, 10)}`;
  const dailyFig = lineChart({
    title: "日別の新着(URL単位)",
    rows: d.daily.map((r) => ({ label: dayLabel(r.date), value: r.total })),
    note: "カテゴリ別の件数の合計は、複数カテゴリの記事を重ねて数えるため、この合計を超えることがあります。",
  });
  const catFig = barChart({
    title: "カテゴリ別の件数",
    rows: CATEGORIES.map((c) => ({ label: catLabel(c), value: d.counts.by_category[c] ?? 0, cls: c })),
  });

  const chapters = d.chapters.map((ch) =>
    h(
      "section",
      { class: "chapter", id: `sec-${ch.category}` },
      h("h2", null, dot(ch.category), catLabel(ch.category), h("span", { class: "lane-count num" }, `${ch.count}件`)),
      ch.sources?.length
        ? h("div", { class: "source-chips" }, ...ch.sources.map((s) => h("span", { class: "badge" }, `${s.platform} ${s.count}`)))
        : null,
      ch.items.length
        ? h("ul", { class: "list" }, ...ch.items.map((a) => renderItem(a)))
        : h("p", { class: "sub" }, "この週の新着はありません"),
      ch.count > ch.items.length
        ? h("p", { class: "lane-foot" }, h("a", { class: "btn", href: `/c/${ch.category}?p=30d`, "data-link": "" }, `${catLabel(ch.category)} をすべて見る`))
        : null,
    ),
  );

  const content = h(
    "div",
    null,
    h(
      "section",
      { class: "chapter", id: "sec-summary" },
      h("p", { class: "sub" }, ep.headline),
      d.highlights?.length ? h("ul", { class: "list" }, ...d.highlights.map((a) => renderItem(a, { showCategoryBadge: false }))) : null,
    ),
    h("section", { id: "sec-figures", class: "chapter" }, dailyFig, catFig),
    ...chapters,
  );

  const readWeek = readButton("特集を読み上げ", `週次特集 ${res.date}`, () => [
    { label: "概要", text: [ep.headline, ...(d.highlights ?? []).map(itemText)].join(" ") },
    ...d.chapters.map((ch) => ({
      label: catLabel(ch.category),
      text: `${catLabel(ch.category)}、${ch.count}件。` + ch.items.map(itemText).join(" "),
    })),
  ]);

  view.replaceChildren(
    crumbs(h("a", { href: "/", "data-link": "" }, "放送"), h("a", { href: "/weekly", "data-link": "" }, "特集"), res.date),
    h("h1", null, "週次", h("em", null, "特集")),
    h("p", { class: "sub" }, h("time", { class: "mono" }, `${res.date}`), ` ・ 新着 ${d.counts.total}件`),
    h("div", { class: "row-controls" }, weekSelect, readWeek),
    h("div", { class: "weekly" }, toc, content),
  );
  // 週次の動きは「線が引かれる」と「目次の現在位置」の2種類
  attachScrollSpy(toc, sections.map((s) => s.id));
}

// ------------------------------------------------------------------ ページ: レポート(週次ダイジェスト)

async function pageReports(view) {
  view.replaceChildren(renderSkeleton());
  const res = await api("/api/reports");
  const reports = res.reports ?? [];

  if (!reports.length) {
    view.replaceChildren(
      h("h1", null, "週次", h("em", null, "レポート")),
      renderEmpty(
        "まだレポートがありません",
        "週次ダイジェスト(水曜・日曜の朝に生成)が取り込まれると、ここに並びます。",
      ),
    );
    return;
  }

  const cards = reports.map((r, i) =>
    h(
      "li",
      null,
      h(
        "a",
        { class: "report-card", href: `/reports/${encodeURIComponent(r.id)}`, "data-link": "" },
        h("b", null, r.title),
        h(
          "span",
          { class: "meta" },
          h("time", { class: "mono" }, r.date),
          r.week ? h("span", { class: "badge" }, r.week) : null,
          h("span", null, `${r.sections}章`),
          i === 0 ? h("span", { class: "badge state" }, "最新") : null,
        ),
      ),
    ),
  );

  view.replaceChildren(
    h("h1", null, "週次", h("em", null, "レポート")),
    h("p", { class: "sub" }, "NotebookLM が、その週に集めた記事をカテゴリごとにまとめた週次ダイジェストです。"),
    h("ul", { class: "report-list" }, ...cards),
  );
  fadeIn([...view.querySelectorAll(".report-card")]);
}

async function pageReport(view, id) {
  view.replaceChildren(renderSkeleton());
  let r;
  try {
    r = await api(`/api/reports/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    view.replaceChildren(
      h("h1", null, "レポートが見つかりません"),
      renderEmpty("見つかりません", "一覧から選び直してください。"),
      h("p", { class: "lane-foot" }, h("a", { class: "btn", href: "/reports", "data-link": "" }, "レポートの一覧へ")),
    );
    return;
  }

  const sections = r.sections ?? [];
  const ids = sections.map((s, i) => ({ id: `sec-r${i}`, label: s.heading, category: s.category }));
  const toc = h(
    "nav",
    { class: "toc", "aria-label": "目次" },
    ...ids.map((s) => h("a", { href: `#${s.id}`, "data-anchor": s.id }, s.label)),
  );

  const body = h(
    "div",
    null,
    ...sections.map((s, i) =>
      h(
        "section",
        { class: "chapter", id: ids[i].id },
        h("h2", null, dot(s.category), s.heading),
        h("div", { class: "md" }, renderMarkdown(s.markdown, { baseLevel: 3 })),
        h(
          "p",
          { class: "lane-foot" },
          h("a", { class: "btn", href: `/c/${s.category}`, "data-link": "" }, `${catLabel(s.category)} の記事を見る`),
        ),
      ),
    ),
  );

  const readReport = readButton("レポートを読み上げ", r.title, () =>
    sections.map((s) => ({ label: s.heading, text: `${s.heading}。` + markdownToSpeech(s.markdown) })),
  );

  view.replaceChildren(
    crumbs(h("a", { href: "/", "data-link": "" }, "放送"), h("a", { href: "/reports", "data-link": "" }, "レポート"), r.date),
    h("h1", null, r.title),
    h(
      "div",
      { class: "report-meta" },
      h("span", null, "日付: ", h("time", { class: "mono" }, r.date), r.week ? ` ・ ${r.week}` : ""),
      r.generated_at ? h("span", null, "生成: ", h("time", { class: "mono" }, formatDateTime(r.generated_at))) : null,
      r.intro ? h("span", null, r.intro) : null,
    ),
    h("div", { class: "row-controls" }, readReport, h("a", { class: "btn", href: "/reports", "data-link": "" }, "一覧へ")),
    h("div", { class: "weekly" }, toc, body),
  );

  // レポートの動きは「読み進めの進捗バー」と「目次の現在位置」の2種類
  attachScrollSpy(toc, ids.map((s) => s.id));
  const bar = document.getElementById("progress-bar");
  bar.hidden = false;
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = `${max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0}%`;
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
  cleanup.push(() => {
    window.removeEventListener("scroll", update);
    bar.hidden = true;
    bar.style.width = "0";
  });
}

// ------------------------------------------------------------------ ページ: 状態

async function pageStatus(view) {
  view.replaceChildren(renderSkeleton());
  const [s, merged, failed] = await Promise.all([
    loadStatus(true),
    api("/api/articles?status=merged&limit=30").catch((e) => (e instanceof AuthError ? Promise.reject(e) : { articles: [], total: 0 })),
    api("/api/articles?status=failed&limit=30").catch((e) => (e instanceof AuthError ? Promise.reject(e) : { articles: [], total: 0 })),
  ]);
  const stale = s.last_success_at ? Date.now() - Date.parse(s.last_success_at) > STALE_HOURS * 3600_000 : true;
  const li = s.last_ingest;

  const kv = (pairs) => {
    const dl = h("dl", { class: "kv" });
    for (const [k, v] of pairs) dl.append(h("dt", null, k), h("dd", null, v));
    return dl;
  };

  const ingest = h(
    "section",
    { class: "panel" },
    h("h2", null, "取り込み"),
    kv([
      [
        "最後に受け付けた時刻",
        s.last_success_at
          ? [h("time", { class: "mono" }, formatDateTime(s.last_success_at)), " ", `(${relativeTime(s.last_success_at)})`, stale ? h("span", { class: "badge warn" }, "止まっている可能性") : null]
          : "まだありません",
      ],
      [
        "直近の取り込み",
        li
          ? `記事 ${li.accepted}件 / 拒否 ${li.rejected}件 / episode ${li.episodes}件 / レポート ${li.reports ?? 0}件 / ウォッチ ${li.watch ?? 0}件 / 削除 ${li.purged}件`
          : "まだありません",
      ],
    ]),
  );

  // 収集元ごとの取得件数(health.json の by_source。直近の日次の実行)
  const run = s.last_run;
  const bySource = Object.entries(run?.by_source ?? {});
  const sourcePanel = bySource.length
    ? h(
        "section",
        { class: "panel" },
        h("h2", null, "収集元ごとの取得件数(直近の実行)"),
        h(
          "table",
          { class: "plain" },
          h("thead", null, h("tr", null, h("th", null, "収集元"), h("th", { class: "num" }, "取得"))),
          h("tbody", null, ...bySource.map(([name, n]) => h("tr", null, h("td", null, name), h("td", { class: "num" }, String(n))))),
        ),
        run.collected != null || run.new != null
          ? h("p", { class: "fig-note" }, `合計 ${run.collected ?? "—"}件 ・ 新規 ${run.new ?? "—"}件(${formatDateTime(run.received_at)} に受信)`)
          : null,
      )
    : null;

  const byCat = h(
    "section",
    { class: "panel" },
    h("h2", null, "記事"),
    kv([
      ["総数(URL単位)", h("span", { class: "num" }, String(s.articles.total))],
      ["要確認", h("span", { class: "num" }, String(s.articles.review))],
      ...allCategoryIds().map((c) => [catLabel(c), h("span", { class: "num" }, String(s.articles.by_category[c] ?? 0))]),
    ]),
  );

  const eps = h(
    "section",
    { class: "panel" },
    h("h2", null, "放送・レポート・ウォッチ"),
    kv([
      ["最新の日次", s.episodes.latest_daily ?? "なし"],
      ["最新の週次", s.episodes.latest_weekly ?? "なし"],
      ["レポート", s.reports ? `${s.reports.total}件(最新 ${s.reports.latest ?? "なし"})` : "なし"],
      ["ウォッチ", s.watch ? `${s.watch.total}件` : "なし"],
    ]),
  );

  const failures = s.failures.length
    ? h(
        "details",
        { class: "acc", open: s.failures.length <= 3 },
        h("summary", null, `取得に失敗した収集元(${s.failures.length}件)`),
        h("ul", null, ...s.failures.map((f) => h("li", null, f.source, f.error ? h("div", { class: "err" }, f.error) : null))),
      )
    : h("section", { class: "panel" }, h("h2", null, "取得に失敗した収集元"), h("p", { class: "sub" }, "ありません"));

  const articleAcc = (title, res, note) =>
    res.articles.length
      ? h(
          "details",
          { class: "acc" },
          h("summary", null, `${title}(${res.total}件)`),
          h("p", { class: "tool-note" }, note),
          h(
            "ul",
            null,
            ...res.articles.map((a) =>
              h(
                "li",
                null,
                h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, a.title),
                a.merged_into ? h("div", { class: "err" }, `→ ${a.merged_into}`) : null,
              ),
            ),
          ),
        )
      : null;

  view.replaceChildren(
    h("h1", null, "状態"),
    ingest,
    sourcePanel,
    byCat,
    eps,
    failures,
    articleAcc("統合された記事", merged, "似た記事を1本にまとめたものです。矢印の先が代表の記事です。"),
    articleAcc("NotebookLM への追加に失敗した記事", failed, "次回の実行で再試行されます。"),
  );
  fadeIn([...view.querySelectorAll(".panel, details")]);
}

// ------------------------------------------------------------------ ページ: ログイン

function pageLogin(view, params) {
  const err = h("p", { class: "err", role: "alert" });
  const input = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true, "aria-label": "パスワード" });
  const form = h(
    "form",
    {
      class: "login",
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = "";
        try {
          await api("/api/login", { method: "POST", body: { password: input.value } });
          state.session = { ...state.session, authenticated: true, via: "session" };
          state.boardLoaded = false;
          input.value = "";
          updateAuthUi();
          const next = params.get("next");
          navigate(next && next.startsWith("/") && !next.startsWith("//") && next !== "/login" ? next : "/");
        } catch (e) {
          err.textContent = e instanceof AuthError ? "パスワードが違います" : "ログインできませんでした。時間をおいてやり直してください";
          input.select();
        }
      },
    },
    h("h1", null, "ログイン"),
    h("label", { for: "pw" }, "閲覧用パスワード"),
    input,
    err,
    h("button", { class: "btn primary", type: "submit" }, "ログイン"),
  );
  input.id = "pw";
  view.replaceChildren(form);
  input.focus();
}

function pageNotFound(view) {
  view.replaceChildren(h("h1", null, "ページが見つかりません"), renderEmpty("404", "URL を確認するか、放送ページへ戻ってください。"));
}

// ------------------------------------------------------------------ ルーター

const ROUTES = [
  { re: /^\/$/, nav: "home", title: "今日の放送", run: (v, _m, q) => pageHome(v, q) },
  { re: /^\/c\/([a-z_]+)$/, nav: "home", title: "カテゴリ", run: (v, m, q) => pageCategory(v, m[1], q) },
  { re: /^\/board$/, nav: "board", title: "ボード", run: (v, _m, q) => pageBoard(v, q) },
  { re: /^\/weekly(?:\/(\d{4}-W\d{2}))?$/, nav: "weekly", title: "週次特集", run: (v, m) => pageWeekly(v, m[1] ?? null) },
  { re: /^\/reports$/, nav: "reports", title: "レポート", run: (v) => pageReports(v) },
  { re: /^\/reports\/(digest:\d{4}-\d{2}-\d{2})$/, nav: "reports", title: "レポート", run: (v, m) => pageReport(v, m[1]) },
  { re: /^\/status$/, nav: "status", title: "状態", run: (v) => pageStatus(v) },
  { re: /^\/login$/, nav: null, title: "ログイン", run: (v, _m, q) => pageLogin(v, q) },
];

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  closeDrawer();
  cleanup.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 片付けの失敗は無視 */
    }
  });
  cleanup = [];

  const url = new URL(location.href);
  renderedPath = url.pathname + url.search;
  const view = document.getElementById("view");
  // パスの中の ":"(レポートの id)は、サーバーが %3A に直すことがある。照合は復号した形で行う
  let routePath = url.pathname;
  try {
    routePath = decodeURIComponent(url.pathname);
  } catch {
    /* 不正な % は、そのまま照合して「見つかりません」にする */
  }
  const route = ROUTES.map((r) => ({ r, m: r.re.exec(routePath) })).find((x) => x.m);

  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (route && a.dataset.nav === route.r.nav) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.title = `${route ? route.r.title : "見つかりません"} — Research Broadcast`;

  try {
    if (url.pathname !== "/login") {
      await loadCategories().catch((e) => (e instanceof AuthError ? Promise.reject(e) : undefined));
    }
    if (!route) pageNotFound(view);
    else await route.r.run(view, route.m, url.searchParams);
  } catch (err) {
    if (token !== renderToken) return; // 新しい遷移が始まっている
    if (err instanceof AuthError) {
      if (url.pathname !== "/login") {
        const next = url.pathname + url.search;
        history.replaceState(null, "", `/login?next=${encodeURIComponent(next)}`);
        return render();
      }
    } else {
      view.replaceChildren(
        h("h1", null, "読み込めませんでした"),
        renderEmpty("データを取得できませんでした", "時間をおいてもう一度開いてください。続く場合は「状態」を確認してください。"),
      );
      console.error(err);
    }
  }
  if (token !== renderToken) return;
  if (url.pathname !== "/login") renderStatusBar();
  else document.getElementById("status-bar").replaceChildren();
}

function navigate(path) {
  history.pushState(null, "", path);
  window.scrollTo(0, 0);
  render().then(() => document.getElementById("view").focus({ preventScroll: true }));
}

function updateAuthUi() {
  document.getElementById("logout-btn").hidden = state.session.via !== "session";
}

// ------------------------------------------------------------------ 起動

document.addEventListener("click", (ev) => {
  const a = ev.target instanceof Element ? ev.target.closest("a[data-link]") : null;
  if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith("/")) return;
  ev.preventDefault();
  navigate(href);
});
// 目次などのハッシュ移動(#sec-…)では描き直さない
let renderedPath = location.pathname + location.search;
window.addEventListener("popstate", () => {
  const now = location.pathname + location.search;
  if (now === renderedPath) return;
  render();
});

player.initPlayerUI();

// 固定ヘッダの高さを CSS 変数にする(スティッキーな要素の位置に使う。CSSOM 経由なので CSP に当たらない)
const topEl = document.querySelector(".top");
const syncTopHeight = () => document.documentElement.style.setProperty("--top-h", `${topEl.offsetHeight}px`);
syncTopHeight();
if ("ResizeObserver" in window) new ResizeObserver(syncTopHeight).observe(topEl);

document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (ev) => {
  const drawer = document.getElementById("drawer");
  if (drawer.hidden) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeDrawer();
    return;
  }
  if (ev.key === "Tab") {
    // フォーカスをドロワーの中に閉じ込める
    const f = [...drawer.querySelectorAll("button, a[href], input, select, textarea")].filter((el) => !el.disabled);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
});

document.getElementById("theme-btn").addEventListener("click", () => {
  const root = document.documentElement;
  const current =
    root.getAttribute("data-theme") ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try {
    localStorage.setItem("rb-theme", next);
  } catch {
    /* 保存できなくても動く */
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* Cookie が既に無効でも続ける */
  }
  state.session = { ...state.session, authenticated: false, via: null };
  state.board = new Map();
  state.boardLoaded = false;
  state.categoriesLoaded = false;
  EXTRA = [];
  state.status = null;
  player.stop();
  updateAuthUi();
  navigate("/login");
});

(async () => {
  try {
    state.session = await api("/api/session");
  } catch {
    /* 取得できなくても、ページ側の 401 処理で扱う */
  }
  updateAuthUi();
  render();
})();
