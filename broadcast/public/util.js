// Research Broadcast — DOM の組み立て・日付・動きの小さな道具(他のモジュールに依存しない)
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)


export const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ 小さな道具

/** DOM を作る。children は文字列(textContent)か Node。属性は class / dataset / on* / その他。 */
export function h(tag, attrs, ...children) {
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

export const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** http(s) か、サイト内の相対パスだけ通す。それ以外は "#" にする。 */
export function safeHref(v) {
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

export const pad2 = (n) => String(n).padStart(2, "0");
export const jstNow = () => new Date(Date.now() + 9 * 3600_000);
export const ymd = (d) => d.toISOString().slice(0, 10);

export function jstToday() {
  return ymd(jstNow());
}
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
export function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 月=0
  return addDays(day, -dow);
}

export function formatDateTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "不明";
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
export function relativeTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (min < 60) return `${min}分前`;
  if (min < 60 * 48) return `${Math.round(min / 60)}時間前`;
  return `${Math.round(min / 1440)}日前`;
}
export const shortDate = (s) => (s && s.length >= 10 ? s.slice(5, 10) : "");

export function toast(message, isError = false) {
  const box = document.getElementById("toasts");
  const el = h("div", { class: `toast${isError ? " err" : ""}`, role: isError ? "alert" : "status" }, message);
  box.append(el);
  setTimeout(() => el.remove(), 3800);
}

export function countUp(root) {
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

export function fadeIn(nodes) {
  if (reduceMotion) return;
  nodes.forEach((n, i) => {
    n.classList.add("fade");
    n.style.animationDelay = `${Math.min(i, 8) * 60}ms`; // CSSOM 経由(CSP の style 属性禁止に当たらない)
  });
}


export function renderEmpty(title, text) {
  return h("div", { class: "empty" }, h("b", null, title), h("span", null, text));
}

export function renderSkeleton() {
  return h(
    "div",
    { "aria-hidden": "true" },
    h("div", { class: "skeleton" }),
    h("div", { class: "skeleton" }),
    h("div", { class: "skeleton" }),
    h("div", { class: "skeleton" }),
  );
}

export function pageNotFound(view) {
  mount(view, h("h1", null, "ページが見つかりません"), renderEmpty("404", "URL を確認するか、放送ページへ戻ってください。"));
}


/** パンくず。最後の1つは現在のページ(リンクにしない)。区切りは読み上げに含めない。 */
export function crumbs(...parts) {
  const nav = h("nav", { class: "crumbs", "aria-label": "パンくず" });
  parts.forEach((part, i) => {
    if (i > 0) nav.append(h("span", { "aria-hidden": "true" }, "›"));
    const last = i === parts.length - 1;
    nav.append(typeof part === "string" ? h("span", { "aria-current": last ? "page" : null }, part) : part);
  });
  return nav;
}

/**
 * 親の中身を入れ替える。null / undefined / false は無視する。
 * (DOM の replaceChildren / append は null を「null」という文字として入れてしまうため、条件つきの部品はこれで渡す。)
 */
export function mount(parent, ...nodes) {
  parent.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));
}
