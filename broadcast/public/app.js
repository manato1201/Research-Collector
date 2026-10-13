// Research Broadcast — サイト本体(依存なしの SPA)
//
// 方針:
//  - データは同一オリジンの /api/* から取る。HTML 文字列を組み立てない(DOM + textContent のみ)。
//  - リンク先は http(s) だけ許可する(記事の URL は外部入力なので javascript: 等を弾く)。
//  - 動きは「カウントアップ」と「フェードイン」の2種類だけ。prefers-reduced-motion では止める。
//  - 読み上げはブラウザの speechSynthesis(無料。声は端末による)。再生バーと章の送りは player.js。
//  - レポート(Markdown)は markdown.js で、DOM + textContent だけで描画する。
//  - 認証: 401 が返ったらログイン画面へ。ボードの書き込みは Cookie + Origin 検査(Worker 側)。
//
// 構成: util.js(道具)/ store.js(カテゴリ・API・状態)/ components.js(共通部品)/ router.js(ルーター)/
//       page-*.js(各ページ)/ player.js(読み上げ)/ markdown.js(レポートの描画)。このファイルは入口で、配線だけを行う。

import { api, resetSessionState, state } from "./store.js";
import { closeDrawer } from "./components.js";
import { beforeRender, getLastRendered, navigate, registerRoutes, render, updateAuthUi } from "./router.js";
import * as player from "./player.js";
import { pageHome } from "./page-home.js";
import { pageCategory } from "./page-category.js";
import { pageBoard } from "./page-board.js";
import { pageRadio } from "./page-radio.js";
import { pageSearch } from "./page-search.js";
import { pageSettings } from "./page-settings.js";
import { initKeys } from "./keys.js";
import { getHideRead, setHideRead } from "./store.js";
import { pageWeekly } from "./page-weekly.js";
import { pageReport, pageReports } from "./page-reports.js";
import { pageStatus } from "./page-status.js";
import { pageLogin } from "./page-login.js";

// ルート表(ページのモジュールを、ここで結びつける)
registerRoutes([
  { re: /^\/$/, nav: "home", title: "今日の放送", run: (v, _m, q) => pageHome(v, q) },
  { re: /^\/c\/([a-z_]+)$/, nav: "home", title: "カテゴリ", run: (v, m, q) => pageCategory(v, m[1], q) },
  { re: /^\/search$/, nav: "home", title: "検索", run: (v, _m, q) => pageSearch(v, q) },
  { re: /^\/settings$/, nav: "settings", title: "設定", run: (v) => pageSettings(v) },
  { re: /^\/radio$/, nav: "radio", title: "ラジオ", run: (v, _m, q) => pageRadio(v, q) },
  { re: /^\/board$/, nav: "board", title: "ボード", run: (v, _m, q) => pageBoard(v, q) },
  { re: /^\/weekly(?:\/(\d{4}-W\d{2}))?$/, nav: "weekly", title: "週次特集", run: (v, m) => pageWeekly(v, m[1] ?? null) },
  { re: /^\/reports$/, nav: "reports", title: "レポート", run: (v) => pageReports(v) },
  { re: /^\/reports\/(digest:\d{4}-\d{2}-\d{2})$/, nav: "reports", title: "レポート", run: (v, m) => pageReport(v, m[1]) },
  { re: /^\/status$/, nav: "status", title: "状態", run: (v) => pageStatus(v) },
  { re: /^\/login$/, nav: null, title: "ログイン", run: (v, _m, q) => pageLogin(v, q) },
]);

// 画面を描き直す前に、ドロワーを閉じる
beforeRender.push(closeDrawer);

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
window.addEventListener("popstate", () => {
  const now = location.pathname + location.search;
  if (now === getLastRendered()) return;
  render();
});

player.initPlayerUI();
initKeys();

// ホーム画面に追加・オフラインで直近の内容を見る(sw.js)。登録に失敗しても、サイトは普通に動く
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
const setOffline = () => {
  document.body.dataset.offline = navigator.onLine ? "0" : "1";
};
window.addEventListener("online", setOffline);
window.addEventListener("offline", setOffline);
setOffline();

// 検索ボックス(ヘッダ)。Enter で検索ページへ
document.getElementById("search-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const input = document.getElementById("search-input");
  const q = input.value.trim();
  if (q) {
    navigate(`/search?q=${encodeURIComponent(q)}`);
    input.blur();
  }
});

// 「既読を隠す」(この端末の設定。localStorage)
const hideBtn = document.getElementById("hide-read-btn");
setHideRead(getHideRead());
hideBtn.setAttribute("aria-pressed", String(getHideRead()));
hideBtn.addEventListener("click", () => {
  const next = !getHideRead();
  setHideRead(next);
  hideBtn.setAttribute("aria-pressed", String(next));
});

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
  resetSessionState();
  player.stop();
  // 端末に保存した API の応答(記事・ボード等)も消す
  navigator.serviceWorker?.controller?.postMessage({ type: "clear" });
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
