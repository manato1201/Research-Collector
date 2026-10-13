// Research Broadcast — 記事の行・ドロワー・読み上げボタン・目次・速報などの共通部品
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { formatDateTime, h, jstToday, shortDate, toast } from "./util.js";
import { AuthError, BOARD_LABELS, DRAWER_STATES, api, catLabel, cleanup, dot, projectsFor, state } from "./store.js";
import { navigate } from "./router.js";
import * as player from "./player.js";

// ------------------------------------------------------------------ 共通の部品

/** 一覧の行(li)→ 記事。キーボード操作(j/k/o/x)が、行から記事を取り出すために使う。 */
export const itemData = new WeakMap();

export const isNewToday = (a) => (a.collected_at ?? "").slice(0, 10) === jstToday();

export function renderItem(a, { showCategoryBadge = true } = {}) {
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
  // 「既読」は、バッジではなく薄い表示で表す(一覧がバッジだらけにならないように)
  if (board && board.state !== "read") {
    meta.append(h("span", { class: "badge state", title: "ボードに入れた状態" }, BOARD_LABELS[board.state] ?? board.state));
  }
  for (const name of projectsFor(a)) {
    meta.append(h("span", { class: "badge project", title: "設定した関連プロジェクトのキーワードに当てはまります" }, `# ${name}`));
  }

  const li = h(
    "li",
    { class: `item${board?.state === "read" ? " is-read" : ""}`, dataset: { hash: a.url_hash } },
    h("button", { class: "item-title", type: "button", onclick: () => openDrawer(a) }, a.title),
    h("time", { class: "item-date mono" }, shortDate(a.published ?? a.collected_at ?? "")),
    meta,
  );
  if (a.summary) li.append(h("p", { class: "item-sum" }, a.summary));
  itemData.set(li, a);
  return li;
}


export function sourceChips(sources, active, onPick) {
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

export let drawerReturnFocus = null;
export const inertTargets = () => [document.getElementById("view"), document.querySelector(".top"), document.querySelector(".foot")];

export function openDrawer(article) {
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

export function closeDrawer() {
  const drawer = document.getElementById("drawer");
  if (drawer.hidden) return;
  drawer.hidden = true;
  document.getElementById("drawer-backdrop").hidden = true;
  inertTargets().forEach((el) => el?.removeAttribute("inert"));
  if (drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus();
  drawerReturnFocus = null;
}

export function buildDrawerBody(a) {
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
    {
      class: "btn primary",
      href: a.url ?? "#",
      target: "_blank",
      rel: "noopener noreferrer",
      // 記事を開いたら、まだ何も付けていない記事は「既読」にする(読む / 試す / 保留 は、そのまま)
      onclick: () => {
        if (!state.board.has(a.url_hash)) markQuietly(a, refresh);
      },
    },
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
      ...DRAWER_STATES.map((s) =>
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

export async function setBoard(article, newState, note, rerender) {
  try {
    if (newState === "unread") {
      await api(`/api/board/${article.url_hash}`, { method: "DELETE" });
      state.board.delete(article.url_hash);
    } else {
      await api(`/api/board/${article.url_hash}`, { method: "PUT", body: { state: newState, note: note.trim() } });
      state.board.set(article.url_hash, { state: newState, note: note.trim() });
    }
    rerender();
    toast(
      newState === "unread" ? "未読に戻しました" : newState === "read" ? "既読にしました" : `「${BOARD_LABELS[newState]}」に入れました`,
    );
    refreshItemBadges(article.url_hash);
  } catch (err) {
    if (err instanceof AuthError) return navigate("/login");
    toast("ボードを更新できませんでした。時間をおいてやり直してください", true);
  }
}

/** 一覧に出ている同じ記事の「ボード」バッジだけを更新する(一覧を描き直さない)。 */
export function refreshItemBadges(hash) {
  const board = state.board.get(hash);
  for (const li of document.querySelectorAll(`#view .item[data-hash="${hash}"]`)) {
    li.querySelector(".badge.state")?.remove();
    li.classList.toggle("is-read", board?.state === "read");
    if (board && board.state !== "read") {
      li.querySelector(".item-meta")?.append(h("span", { class: "badge state" }, BOARD_LABELS[board.state]));
    }
  }
}

/** 通知を出さずに既読にする(記事のリンクを開いたときなど)。失敗しても、記事は開ける。 */
async function markQuietly(article, rerender) {
  try {
    await api(`/api/board/${article.url_hash}`, { method: "PUT", body: { state: "read", note: "" } });
    state.board.set(article.url_hash, { state: "read", note: "" });
    rerender?.();
    refreshItemBadges(article.url_hash);
  } catch {
    /* 既読にできなくても、読むのは妨げない */
  }
}

/**
 * 一覧の記事を、まとめて既読にする(最大200件。読む / 試す / 保留 に入れたものは、そのまま)。
 * @returns {Promise<number>} 新しく既読になった件数
 */
export async function markAllRead(articles) {
  const targets = articles.filter((a) => !state.board.has(a.url_hash)).slice(0, 200);
  if (!targets.length) {
    toast("未読の記事はありません");
    return 0;
  }
  try {
    await api("/api/board/bulk", { method: "POST", body: { hashes: targets.map((a) => a.url_hash), state: "read" } });
    for (const a of targets) {
      state.board.set(a.url_hash, { state: "read", note: "" });
      refreshItemBadges(a.url_hash);
    }
    toast(`${targets.length}件を既読にしました`);
    return targets.length;
  } catch (err) {
    if (err instanceof AuthError) navigate("/login");
    else toast("既読にできませんでした。時間をおいてやり直してください", true);
    return 0;
  }
}

// ------------------------------------------------------------------ 読み上げ(ブラウザの音声。再生バーは player.js)

export const itemText = (a) => `${a.title}。${a.summary ?? ""}`.trim();
export const chapterLabel = (a, i) => `${i + 1}. ${String(a.title).slice(0, 36)}`;
export const itemsToChapters = (items, n = 10) =>
  items.slice(0, n).map((a, i) => ({ label: chapterLabel(a, i), text: itemText(a) }));

/**
 * 読み上げのボタン。押すと再生バーが出て、章ごとにスキップできる。
 * build は押したときに呼ぶ(読み上げる内容を、その時点の表示から作る)。
 * 読み上げに対応していないブラウザでは、無効にして理由を出す。
 */
export function readButton(label, title, build) {
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

export function attachScrollSpy(toc, ids) {
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
export function buildTicker(items) {
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
