// Research Broadcast — ページ: 週次特集
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { crumbs, h, mount, renderEmpty, renderSkeleton } from "./util.js";
import { CATEGORIES, api, catLabel, dot, loadBoard } from "./store.js";
import { attachScrollSpy, itemText, readButton, renderItem } from "./components.js";
import { navigate } from "./router.js";
import { barChart, lineChart } from "./figures.js";

// ------------------------------------------------------------------ ページ: 週次特集(図は SVG)

function buildKeywords(keywords, prevTotal) {
  return h(
    "section",
    { id: "sec-keywords", class: "chapter" },
    h("h2", null, "今週のキーワード"),
    h(
      "p",
      { class: "sub" },
      prevTotal ? `先週(新着${prevTotal}件)との差。「新」は先週は出なかった語、「+n」は先週より増えた件数です。` : "先週のデータが無いため、差は出していません。",
    ),
    h(
      "div",
      { class: "source-chips" },
      ...keywords.map((k) => {
        const diff = k.count - k.prev;
        return h(
          "a",
          {
            class: `chip${k.new && prevTotal ? " hit" : ""}`,
            href: `/search?q=${encodeURIComponent(k.word)}`,
            "data-link": "",
            title: `今週 ${k.count}件 / 先週 ${k.prev}件`,
          },
          k.word,
          h("span", { class: "n" }, String(k.count)),
          prevTotal && k.new ? h("span", { class: "badge" }, "新") : null,
          prevTotal && !k.new && diff >= 2 ? h("span", { class: "badge" }, `+${diff}`) : null,
        );
      }),
    ),
  );
}

export async function pageWeekly(view, label) {
  mount(view, renderSkeleton());
  const [res, datesRes] = await Promise.all([
    api(`/api/episodes?kind=weekly&date=${label ?? "latest"}`),
    api("/api/episodes/dates?kind=weekly"),
    loadBoard(),
  ]);
  const ep = res.episodes.find((e) => e.category === null);
  if (!res.date || !ep) {
    mount(view, 
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

  const keywords = d.keywords ?? [];
  const sections = [{ id: "sec-summary", label: "概要" }, { id: "sec-figures", label: "図" }];
  if (keywords.length) sections.push({ id: "sec-keywords", label: "キーワード" });
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
    keywords.length ? buildKeywords(keywords, d.prev_total) : null,
    ...chapters,
  );

  const readWeek = readButton("特集を読み上げ", `週次特集 ${res.date}`, () => [
    { label: "概要", text: [ep.headline, ...(d.highlights ?? []).map(itemText)].join(" ") },
    ...d.chapters.map((ch) => ({
      label: catLabel(ch.category),
      text: `${catLabel(ch.category)}、${ch.count}件。` + ch.items.map(itemText).join(" "),
    })),
  ]);

  mount(view, 
    crumbs(h("a", { href: "/", "data-link": "" }, "放送"), h("a", { href: "/weekly", "data-link": "" }, "特集"), res.date),
    h("h1", null, "週次", h("em", null, "特集")),
    h("p", { class: "sub" }, h("time", { class: "mono" }, `${res.date}`), ` ・ 新着 ${d.counts.total}件`),
    h("div", { class: "row-controls" }, weekSelect, readWeek),
    h("div", { class: "weekly" }, toc, content),
  );
  // 週次の動きは「線が引かれる」と「目次の現在位置」の2種類
  attachScrollSpy(toc, sections.map((s) => s.id));
}
