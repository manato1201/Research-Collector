// Research Broadcast — ページ: ボード
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { fadeIn, h, mount, renderSkeleton } from "./util.js";
import { BOARD_LABELS, BOARD_ORDER, allCategoryIds, api, catLabel, state } from "./store.js";
import { renderItem } from "./components.js";
import { navigate } from "./router.js";

// ------------------------------------------------------------------ ページ: ボード

export async function pageBoard(view, params) {
  mount(view, renderSkeleton());
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

  mount(view, 
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
