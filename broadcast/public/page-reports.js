// Research Broadcast — ページ: レポート(週次ダイジェスト)
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { crumbs, fadeIn, formatDateTime, h, mount, renderEmpty, renderSkeleton } from "./util.js";
import { AuthError, api, catLabel, cleanup, dot } from "./store.js";
import { attachScrollSpy, readButton } from "./components.js";
import { markdownToSpeech, renderMarkdown } from "./markdown.js";

// ------------------------------------------------------------------ ページ: レポート(週次ダイジェスト)

export async function pageReports(view) {
  mount(view, renderSkeleton());
  const res = await api("/api/reports");
  const reports = res.reports ?? [];

  if (!reports.length) {
    mount(view, 
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

  mount(view, 
    h("h1", null, "週次", h("em", null, "レポート")),
    h("p", { class: "sub" }, "NotebookLM が、その週に集めた記事をカテゴリごとにまとめた週次ダイジェストです。"),
    h("ul", { class: "report-list" }, ...cards),
  );
  fadeIn([...view.querySelectorAll(".report-card")]);
}

export async function pageReport(view, id) {
  mount(view, renderSkeleton());
  let r;
  try {
    r = await api(`/api/reports/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    mount(view, 
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

  mount(view, 
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
