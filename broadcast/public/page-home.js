// Research Broadcast — ページ: 今日の放送
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { addDays, countUp, h, jstToday, mount, renderEmpty, renderSkeleton, shortDate } from "./util.js";
import { AuthError, CATEGORIES, EXTRA, api, catLabel, dot, loadBoard, loadStatus } from "./store.js";
import { buildTicker, itemsToChapters, readButton, renderItem } from "./components.js";
import { navigate } from "./router.js";
import { programChapters, programFromEpisodes } from "./page-radio.js";

const HOME_LANE_ITEMS = 8;

// ------------------------------------------------------------------ ページ: 今日の放送

export async function pageHome(view, params) {
  mount(view, renderSkeleton());
  const wanted = params.get("d");
  const dateQuery = wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : "latest";
  const [{ date, episodes }, datesRes, watch, status, extraLanes] = await Promise.all([
    api(`/api/episodes?kind=daily&date=${dateQuery}`),
    api("/api/episodes/dates?kind=daily"),
    api("/api/watch").catch((e) => (e instanceof AuthError ? Promise.reject(e) : { items: [] })),
    loadStatus().catch(() => null),
    // 追加カテゴリは、直近7日に収集した記事を API から直接取る(episode は基本の3つだけ)
    Promise.all(
      EXTRA.map(async (e) => {
        // 1つの追加カテゴリの取得に失敗しても、ページ全体は表示する(認証切れだけは伝える)
        try {
          const res = await api(
            `/api/articles?category=${e.id}&status=added&collected_since=${addDays(jstToday(), -6)}&order=collected&limit=8`,
          );
          return { ...e, total: res.total, items: res.articles.map((a) => ({ ...a, other_categories: [] })) };
        } catch (err) {
          if (err instanceof AuthError) throw err;
          return { ...e, total: 0, items: [], failed: true };
        }
      }),
    ),
    loadBoard(),
  ]);

  const all = episodes.find((e) => e.category === null);
  const lanes = Object.fromEntries(episodes.filter((e) => e.category).map((e) => [e.category, e]));

  if (!date || !all) {
    mount(view, 
      h("h1", null, "今日の", h("em", null, "放送")),
      renderEmpty("まだ放送がありません", "収集が実行されると、ここに今日の新着が並びます。"),
    );
    return;
  }

  const counts = all.data.counts;
  const stat = (n, label, cls) =>
    h(
      "div",
      { class: "stat" },
      h("span", { class: `stat-num ${cls ?? ""}` }, h("span", { class: "num", "data-count": String(n) }, "0"), h("small", null, "件")),
      h("span", { class: "stat-label" }, label),
    );

  const dateSelect = h(
    "select",
    { class: "btn", "aria-label": "日付を選ぶ", onchange: (ev) => navigate(`/?d=${ev.target.value}`) },
    ...datesRes.dates.map((d) => h("option", { value: d, selected: d === date }, d)),
  );

  // 全体の読み上げ: ラジオの番組(オープニング → 注目 → カテゴリ別のコーナー → エンディング)
  const readAll = readButton("番組を再生(ラジオ)", `${date} の放送`, () => programChapters(programFromEpisodes(episodes, date)));
  const radioLink = h("a", { class: "btn", href: "/radio", "data-link": "" }, "ラジオを開く");

  const picker = h("div", { class: "lane-picker", role: "group", "aria-label": "カテゴリを選ぶ" });
  let mobileCat = CATEGORIES.find((c) => lanes[c]) ?? CATEGORIES[0];
  const laneEls = {};
  const applyMobile = () => {
    for (const c of CATEGORIES) laneEls[c].dataset.hiddenMobile = String(c !== mobileCat);
    for (const b of picker.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.cat === mobileCat));
  };

  for (const c of CATEGORIES) {
    const ep = lanes[c];
    const items = ep?.data.items ?? [];
    const lane = h(
      "section",
      { class: "lane", "aria-labelledby": `lane-${c}` },
      h("div", { class: "lane-head" }, dot(c), h("h2", { id: `lane-${c}` }, catLabel(c)), h("span", { class: "lane-count num" }, String(ep?.data.count ?? 0))),
    );
    if (ep) {
      lane.append(h("p", { class: "lane-headline" }, ep.headline.replace(/^[^:]+: /, "")));
      lane.append(h("ul", { class: "list" }, ...items.slice(0, HOME_LANE_ITEMS).map((a) => renderItem(a))));
      lane.append(
        h(
          "div",
          { class: "lane-foot" },
          readButton("このカテゴリを読み上げ", `${catLabel(c)} の新着(${date})`, () => itemsToChapters(items)),
          h("a", { class: "btn", href: `/c/${c}`, "data-link": "" }, `すべて見る(${ep.data.count}件)`),
        ),
      );
    } else {
      lane.append(h("p", { class: "lane-headline" }, "この日の新着はありません"));
    }
    laneEls[c] = lane;
    picker.append(
      h("button", { class: "chip", type: "button", "data-cat": c, onclick: () => { mobileCat = c; applyMobile(); } }, catLabel(c)),
    );
  }

  const highlights = all.data.highlights ?? [];
  const hl = highlights.length
    ? h(
        "section",
        { class: "panel", "aria-labelledby": "hl-title" },
        h("h2", { id: "hl-title" }, "注目"),
        h("ol", { class: "list ranked" }, ...highlights.map((a) => renderItem(a, { showCategoryBadge: false }))),
      )
    : null;

  // 速報: 注目 + 各カテゴリの先頭(重複は除く)
  const tickerItems = [];
  const seen = new Set();
  for (const a of [...highlights, ...CATEGORIES.flatMap((c) => (lanes[c]?.data.items ?? []).slice(0, 3))]) {
    if (!seen.has(a.url_hash)) {
      seen.add(a.url_hash);
      tickerItems.push(a);
    }
  }

  const latestReport = status?.reports?.latest;
  const reportLink = latestReport
    ? h("a", { class: "btn", href: `/reports/${encodeURIComponent(`digest:${latestReport}`)}`, "data-link": "" }, `最新のレポート(${latestReport})`)
    : null;

  const watchItems = watch.items ?? [];
  const watchBox = watchItems.length
    ? h(
        "details",
        { class: "acc watch-list" },
        h("summary", null, `配布サイトの新着(通知のみ) ${watchItems.length}件`),
        h("p", { class: "tool-note", style: null }, "導入はしません。中身を確認してから判断してください。"),
        h(
          "ul",
          null,
          ...watchItems.map((w) =>
            h(
              "li",
              null,
              h("time", { class: "mono" }, shortDate(w.detected_at)),
              h("a", { href: w.url, target: "_blank", rel: "noopener noreferrer" }, w.title),
              h("span", { class: "badge" }, w.watch),
            ),
          ),
        ),
      )
    : null;

  mount(view, 
    h(
      "div",
      { class: "hero" },
      h(
        "div",
        null,
        h("span", { class: "onair" }, h("i", { "aria-hidden": "true" }), "ON AIR"),
        h("h1", null, "今日の", h("em", null, "放送")),
        h("p", { class: "sub" }, h("time", { class: "mono" }, date), " ・ ", all.headline),
      ),
      h("div", { class: "stats" }, stat(counts.total, "新着(URL単位)", "new"), stat(counts.review, "要確認")),
    ),
    buildTicker(tickerItems),
    h("div", { class: "row-controls" }, dateSelect, readAll, radioLink, reportLink),
    hl,
    picker,
    h("div", { class: "lanes" }, ...CATEGORIES.map((c) => laneEls[c])),
    extraLanes.length ? buildExtraLanes(extraLanes) : null,
    watchBox,
  );
  applyMobile();
  countUp(view); // トップの動きは「カウントアップ」と「速報の流れ」の2種類(フェードインは使わない)
}

/** 追加カテゴリのレーン(直近7日に収集した記事)。基本の3レーンの下に、別の見出しで出す。 */
function buildExtraLanes(lanes) {
  const box = h(
    "section",
    { class: "extra-lanes", "aria-labelledby": "extra-title" },
    h("h2", { id: "extra-title", class: "extra-title" }, "追加の分野(直近7日に収集)"),
  );
  const grid = h("div", { class: "lanes" });
  for (const l of lanes) {
    const lane = h(
      "section",
      { class: "lane", "aria-labelledby": `lane-${l.id}` },
      h("div", { class: "lane-head" }, dot(l.id), h("h2", { id: `lane-${l.id}` }, l.label), h("span", { class: "lane-count num" }, String(l.total))),
    );
    if (l.items.length) {
      lane.append(h("ul", { class: "list" }, ...l.items.map((a) => renderItem(a, { showCategoryBadge: false }))));
      lane.append(
        h(
          "div",
          { class: "lane-foot" },
          readButton("このカテゴリを読み上げ", `${l.label}(直近7日)`, () => itemsToChapters(l.items)),
          h("a", { class: "btn", href: `/c/${l.id}`, "data-link": "" }, `すべて見る(${l.total}件)`),
        ),
      );
    } else {
      lane.append(h("p", { class: "lane-headline" }, l.failed ? "読み込めませんでした" : "直近7日の新着はありません"));
    }
    grid.append(lane);
  }
  box.append(grid);
  return box;
}
