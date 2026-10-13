// Research Broadcast — ルーター・ステータスバー
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { h, mount, pageNotFound, relativeTime, renderEmpty } from "./util.js";
import { AuthError, STALE_HOURS, cleanup, loadCategories, loadPrefs, loadStatus, state } from "./store.js";

// ------------------------------------------------------------------ ステータスバー(ヘッダ)

export async function renderStatusBar() {
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

// ------------------------------------------------------------------ ルーター

export const ROUTES = []; // app.js が registerRoutes で登録する

/** 画面を描き直す前に呼ぶ処理(ドロワーを閉じる等)。 */
export const beforeRender = [];

export let renderToken = 0;
// 目次などのハッシュ移動(#sec-…)では描き直さないために、最後に描いたパスを覚える
export let lastRendered = location.pathname + location.search;
export function getLastRendered() {
  return lastRendered;
}

export function registerRoutes(routes) {
  ROUTES.push(...routes);
}

export async function render() {
  const token = ++renderToken;
  beforeRender.forEach((fn) => fn());
  cleanup.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 片付けの失敗は無視 */
    }
  });
  cleanup.length = 0;

  const url = new URL(location.href);
  lastRendered = url.pathname + url.search;
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
      await Promise.all([loadCategories(), loadPrefs()]).catch((e) => (e instanceof AuthError ? Promise.reject(e) : undefined));
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
      mount(view, 
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

export function navigate(path) {
  history.pushState(null, "", path);
  window.scrollTo(0, 0);
  render().then(() => document.getElementById("view").focus({ preventScroll: true }));
}

export function updateAuthUi() {
  document.getElementById("logout-btn").hidden = state.session.via !== "session";
}
