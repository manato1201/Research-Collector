// Research Broadcast — ページ: 状態
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { fadeIn, formatDateTime, h, mount, relativeTime, renderSkeleton } from "./util.js";
import { AuthError, STALE_HOURS, allCategoryIds, api, catLabel, loadStatus } from "./store.js";

// ------------------------------------------------------------------ ページ: 状態

export async function pageStatus(view) {
  mount(view, renderSkeleton());
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

  mount(view, 
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
