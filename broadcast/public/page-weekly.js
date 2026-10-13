// Research Broadcast — ページ: 週次特集
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { crumbs, h, mount, reduceMotion, renderEmpty, renderSkeleton, svg } from "./util.js";
import { CATEGORIES, api, catLabel, cleanup, dot, loadBoard } from "./store.js";
import { attachScrollSpy, itemText, readButton, renderItem } from "./components.js";
import { navigate } from "./router.js";

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

/** 今週よく出た語と、先週との差。新出(先週は無かった語)と、増えた語を目立たせる。語を押すと検索へ。 */
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
