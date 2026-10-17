// Research Broadcast — ページ: カテゴリ
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { addDays, crumbs, fadeIn, h, jstToday, mount, pageNotFound, renderEmpty, renderSkeleton, weekStart, ymd } from "./util.js";
import { AuthError, EXTRA, KIND_LABELS, LANG_LABELS, allCategoryIds, api, catLabel, dot, excludeParam, loadBoard } from "./store.js";
import { itemsToChapters, markAllRead, readButton, renderItem, sourceChips } from "./components.js";
import { navigate } from "./router.js";

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

export async function pageCategory(view, cat, params) {
  if (!allCategoryIds().includes(cat)) return pageNotFound(view);
  const period = PERIODS.some(([k]) => k === params.get("p")) ? params.get("p") : "week";
  const source = params.get("s");
  const onlyReview = params.get("r") === "1";
  const kind = KIND_LABELS.some(([k]) => k === params.get("k")) ? params.get("k") : null;
  const lang = LANG_LABELS.some(([k]) => k === params.get("l")) ? params.get("l") : null;

  const today = jstToday();
  let since;
  let until = null;
  if (period === "today") since = today;
  else if (period === "week") since = weekStart(today);
  else if (period === "30d") since = addDays(today, -29);
  else ({ since, until } = previousMonthRange(today));

  mount(view, renderSkeleton());
  // 追加カテゴリは論文が中心で、公開日が古いものも「最近集めた」として見たいので、収集した日で絞る
  const byCollected = EXTRA.some((e) => e.id === cat);
  const [fromKey, toKey] = byCollected ? ["collected_since", "collected_until"] : ["since", "until"];
  const q = `category=${cat}&status=added&${fromKey}=${since}${until ? `&${toKey}=${until}` : ""}${byCollected ? "&order=collected" : ""}${excludeParam()}${kind ? `&kind=${kind}` : ""}${lang ? `&lang=${lang}` : ""}&limit=200`;
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
    const qs = new URLSearchParams({
      p: period,
      ...(source ? { s: source } : {}),
      ...(onlyReview ? { r: "1" } : {}),
      ...(kind ? { k: kind } : {}),
      ...(lang ? { l: lang } : {}),
    });
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
  const markRead = h(
    "button",
    { class: "btn", type: "button", title: "表示中の未読を、すべて既読にします(最大200件)", onclick: () => markAllRead(shown) },
    "表示中をすべて既読に",
  );

  // 出典の種別・言語での絞り込み(サーバー側で絞るので、件数は /api/articles と一致する)
  const mkChip = (label, on, fn) => h("button", { class: "chip", type: "button", "aria-pressed": String(on), onclick: fn }, label);
  const attrRow = (label, pairs, current, key) =>
    h(
      "div",
      { class: "row-controls", role: "group", "aria-label": label },
      mkChip(`${label}: すべて`, current === null, () => go({ [key]: null })),
      ...pairs.map(([id, text]) => mkChip(text, current === id, () => go({ [key]: id }))),
    );
  const filtered = Boolean(kind || lang || source || onlyReview);
  const resetBtn = h(
    "button",
    { class: "btn", type: "button", onclick: () => navigate(`/c/${cat}?p=${period}`) },
    "条件をリセット",
  );

  const list = shown.length
    ? h("ul", { class: "list" }, ...shown.map((a) => renderItem(a)))
    : h(
        "div",
        null,
        renderEmpty("該当する記事がありません", "期間や絞り込みを変えてみてください。"),
        filtered ? h("p", null, resetBtn) : null,
      );

  mount(view, 
    crumbs(h("a", { href: "/", "data-link": "" }, "放送"), catLabel(cat)),
    h("h1", null, dot(cat), " ", catLabel(cat)),
    headline ? h("p", { class: "sub" }, "今日のヘッドライン: ", headline.replace(/^[^:]+: /, "")) : null,
    h("p", { class: "sub" }, `${since}${until ? ` 〜 ${until}` : " 〜"} ・ `, h("span", { class: "num" }, String(shown.length)), "件を表示"),
    // カテゴリの切り替え・絞り込みは、スクロールしても上に固定する(スティッキー)
    h(
      "div",
      { class: "sticky-controls" },
      h("div", { class: "row-controls" }, seg, reviewChip, readThis, markRead, filtered ? resetBtn : null),
      attrRow("種別", KIND_LABELS, kind, "k"),
      attrRow("言語", LANG_LABELS, lang, "l"),
      sourceChips(sources, source, (key) => go({ s: key })),
    ),
    list,
    res.total > res.articles.length
      ? h("p", { class: "fig-note" }, `ほか ${res.total - res.articles.length} 件あります(新しい順に最大200件まで表示)`)
      : null,
  );
  fadeIn([...view.querySelectorAll(".item")].slice(0, 10));
}
