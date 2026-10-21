// Research Broadcast — ページ: ラジオ(今日の放送を、番組として聴く)
//
// 原稿は radio-script.js が、その日の episode と、記事ごとの解説(AI が題名・要約から書いたもの)から規則ベースで組み立てる。
// 読み上げはブラウザの音声(player.js)。番組表から、聴きたいコーナーの頭へ飛べる。

import { navigate } from "./router.js";
import { CATEGORIES, api, catLabel, cleanup, isMuted, loadBoard, loadInsights, projectsFor, state } from "./store.js";
import { pickRecommendation } from "./recommend.js";
import { crumbs, h, jstNow, mount, renderEmpty, renderSkeleton } from "./util.js";
import * as player from "./player.js";
import { buildRadioProgram, formatClock } from "./radio-script.js";

/**
 * 今日のおすすめ(1本)を選ぶ。ウォッチワード・関連プロジェクトに当てはまるものを優先する。
 * @returns {{article, score, reasons, insight, projects: string[]} | null}
 */
export function buildRecommendation(candidates, insights) {
  const pick = pickRecommendation(candidates, {
    watchwords: state.prefs.watchwords,
    projects: state.prefs.projects,
    insights,
    highlights: new Set(candidates.slice(0, 5).map((a) => a.url_hash)),
    isRead: (h) => state.board.get(h)?.state === "read",
    isMuted,
  });
  if (!pick) return null;
  const insight = insights[pick.article.url_hash] ?? null;
  return { ...pick, insight, projects: projectsFor(pick.article) };
}

/** 番組に使う記事の解説をまとめて取る(取れなくても番組は作れる)。 */
async function insightsFor(items) {
  const hashes = items.map((a) => a.url_hash).filter(Boolean);
  try {
    await loadInsights(hashes);
  } catch {
    /* 解説なしで番組を作る */
  }
  return Object.fromEntries(hashes.filter((h) => state.insights.has(h)).map((h) => [h, state.insights.get(h)]));
}

/** daily の episode(全体 + カテゴリ別)から、番組を作る。ホームの「番組を再生」も同じ番組を使う。 */
export async function programFromEpisodes(episodes, date) {
  const all = episodes.find((e) => e.category === null);
  if (!all) return null;
  const byCat = Object.fromEntries(episodes.filter((e) => e.category).map((e) => [e.category, e]));
  const lanes = CATEGORIES.filter((c) => byCat[c]).map((c) => ({
    id: c,
    label: catLabel(c),
    count: byCat[c].data.count ?? byCat[c].data.items?.length ?? 0,
    items: byCat[c].data.items ?? [],
  }));
  // あいさつの時間帯。今日の放送は今の時刻、過去の日付は昼の扱い
  const today = jstNow().toISOString().slice(0, 10);
  const hour = date === today ? jstNow().getUTCHours() : 12;
  const highlights = all.data.highlights ?? [];
  // 番組が選ぶ候補ぶん(各カテゴリの先頭 15 件)の解説を取る。先頭の記事は他のコーナーで読み終わっていることがあるため、多めに
  const items = [...highlights, ...lanes.flatMap((l) => l.items.slice(0, 15))];
  const insights = await insightsFor(items);
  const rec = buildRecommendation(items, insights);
  const ins = rec?.insight;
  return buildRadioProgram({
    date,
    hour,
    total: all.data.counts?.total ?? 0,
    highlights,
    lanes,
    insights,
    recommend: rec && ins
      ? { title: rec.article.title, title_ja: ins.title_ja, what: ins.what, use: ins.use, apply: ins.apply, projects: rec.projects }
      : null,
  });
}

/** プレーヤーに渡す形(章 = コーナー。ジングルつき)。 */
export function programChapters(program) {
  return program.corners.map((c) => ({ label: c.label, text: c.speech, jingle: c.jingle }));
}

const KIND_LABEL = { open: "OP", headlines: "注目", recommend: "おすすめ", category: "コーナー", glossary: "用語", recap: "まとめ", close: "ED" };

export async function pageRadio(view, params) {
  mount(view, renderSkeleton());
  const wanted = params.get("d");
  const dateQuery = wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : "latest";
  const [{ date, episodes }, datesRes] = await Promise.all([
    api(`/api/episodes?kind=daily&date=${dateQuery}`),
    api("/api/episodes/dates?kind=daily"),
    loadBoard(),
  ]);

  const program = date ? await programFromEpisodes(episodes, date) : null;
  if (!program) {
    mount(view, 
      h("h1", null, "リサーチ", h("em", null, "ラジオ")),
      renderEmpty("まだ番組がありません", "収集が実行されると、その日の放送が番組になります。"),
    );
    return;
  }

  const chapters = programChapters(program);

  // 番組表: コーナーごとの開始時刻(速度 1 倍の目安)
  let offset = 0;
  const rows = program.corners.map((c, i) => {
    const start = offset;
    offset += c.seconds;
    return { c, i, start };
  });

  const guide = h(
    "ol",
    { class: "guide", "aria-label": "番組表" },
    ...rows.map(({ c, i, start }) =>
      h(
        "li",
        { class: "guide-row", dataset: { index: String(i) } },
        h("time", { class: "mono guide-time" }, formatClock(start)),
        h("span", { class: `badge${c.kind === "category" ? "" : " state"}` }, KIND_LABEL[c.kind] ?? c.kind),
        h("span", { class: "guide-label" }, c.label),
        h("span", { class: "guide-len mono" }, `約${formatClock(c.seconds)}`),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: !player.supported,
            onclick: () => player.read({ title: program.title, chapters, startAt: i }),
          },
          i === 0 ? "最初から" : "ここから",
        ),
      ),
    ),
  );

  const playAll = h(
    "button",
    {
      class: "btn primary",
      type: "button",
      disabled: !player.supported,
      title: player.supported ? null : "このブラウザは読み上げに対応していません",
      onclick: () => player.read({ title: program.title, chapters }),
    },
    "番組を再生",
  );
  const stopBtn = h("button", { class: "btn", type: "button", onclick: () => player.stop() }, "停止");

  const dateSelect = h(
    "select",
    { class: "btn", "aria-label": "放送の日付を選ぶ", onchange: (ev) => navigate(`/radio?d=${ev.target.value}`) },
    ...datesRes.dates.map((d) => h("option", { value: d, selected: d === date }, d)),
  );

  const sleepSel = h(
    "select",
    { class: "btn", "aria-label": "スリープタイマー", onchange: (ev) => player.setSleep(ev.target.value) },
    h("option", { value: "0" }, "タイマー: なし"),
    h("option", { value: "15" }, "15分で停止"),
    h("option", { value: "30" }, "30分で停止"),
    h("option", { value: "60" }, "60分で停止"),
  );
  const sfxBox = h("input", { type: "checkbox", checked: player.snapshot().sfx, onchange: (ev) => player.setSfx(ev.target.checked) });

  const eq = h("div", { class: "eq", "aria-hidden": "true" }, ...Array.from({ length: 7 }, () => h("span")));

  // 動きを減らす設定のときは、音声と動きに頼らず読めるように、原稿を最初から開く
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const script = h(
    "details",
    { class: "acc", open: reducedMotion },
    h("summary", null, "番組の原稿を読む"),
    h(
      "div",
      { class: "script" },
      ...program.corners.map((c) => h("section", null, h("h3", null, c.label), h("p", null, c.text))),
    ),
  );

  mount(view, 
    crumbs(h("a", { href: "/", "data-link": "" }, "放送"), "ラジオ"),
    h(
      "div",
      { class: "radio-hero" },
      h(
        "div",
        null,
        h("span", { class: "onair" }, h("i", { "aria-hidden": "true" }), "ON AIR"),
        h("h1", null, "リサーチ", h("em", null, "ラジオ")),
        h(
          "p",
          { class: "sub" },
          h("time", { class: "mono" }, date),
          ` ・ 約${formatClock(program.totalSeconds)}の番組(等速の目安)`,
        ),
      ),
      eq,
    ),
    h("div", { class: "row-controls" }, dateSelect, playAll, stopBtn, sleepSel, h("label", { class: "player-check" }, sfxBox, " 効果音")),
    player.supported
      ? null
      : h("p", { class: "tool-note" }, "このブラウザは読み上げに対応していないため、再生できません。原稿は下で読めます。"),
    h("h2", { class: "guide-title" }, "番組表"),
    guide,
    reducedMotion ? h("p", { class: "fig-note" }, "動きを減らす設定のため、番組の原稿を開いています。音声を使わずに、原稿だけで読めます。") : null,
    script,
    h(
      "p",
      { class: "fig-note" },
      "声は、お使いの端末・ブラウザの音声です。音が出ないときは、端末の音量と、日本語の音声が入っているかを確認してください。",
    ),
  );

  // いま再生中のコーナーを、番組表で示す(同じ番組のときだけ)
  const mark = (snap) => {
    const mine = snap.status !== "idle" && snap.title === program.title;
    guide.querySelectorAll(".guide-row").forEach((li) => {
      const on = mine && Number(li.dataset.index) === snap.chapterIndex;
      if (on) li.setAttribute("aria-current", "true");
      else li.removeAttribute("aria-current");
    });
    sleepSel.value = snap.sleepAt ? sleepSel.value : "0";
    sfxBox.checked = snap.sfx;
  };
  mark(player.snapshot());
  cleanup.push(player.onChange(mark));
}
