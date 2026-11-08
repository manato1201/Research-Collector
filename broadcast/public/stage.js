// ラジオの画面(ステージ): 読み上げに合わせて、いま話している話題のカードを出す。
//
// 動画ファイルは作らない。台本(radio-script.js)が、話す内容ごとに「そのとき画面に出す内容(slide)」を持ち、
// プレーヤー(player.js)が、いま読んでいる部分の slide を返す。ここは、それを描くだけ。
//   open       今日の新着の数と、分野別の図
//   corner     コーナーの紹介と、そのコーナーの出どころ別の図
//   item       記事1本のカード(日本語の見出し・かんたんな概要・分かること・用語・原文へ)
//   recommend  今日のおすすめ
//   term       今日の用語ひとこと
//   recap      おさらいと、7日間の推移の図
//   close      終わり
// 文字は textContent のみ。図は実データだけ(AI が作った図は無い)。動きは、既存のフェード1種類だけ(動きを減らす設定で止まる)。

import { h } from "./util.js";
import { catLabel } from "./store.js";
import { openDrawer } from "./components.js";
import { barChart, lineChart } from "./figures.js";
import { categoryRows, dayLabel, hasFigureData, sourceRows, trendRows } from "./figure-data.js";

const aiBadge = () => h("span", { class: "badge state", title: "題名と要約だけを根拠に、AI が書いた説明です。誤りを含むことがあります" }, "AIの解説");

function figureOrNull(rows, title, note) {
  return hasFigureData(rows) ? barChart({ title, rows, note }) : null;
}

function openBody(sl) {
  const rows = categoryRows(Object.fromEntries(sl.categories.map((c) => [c.id, c.count])), catLabel);
  return [
    h("p", { class: "stage-big" }, h("span", { class: "num" }, String(sl.total)), h("small", null, "件の新着")),
    sl.preview?.length ? h("ul", { class: "stage-points" }, ...sl.preview.map((t) => h("li", null, t))) : null,
    figureOrNull(rows, "分野別の新着", "複数の分野にまたがる記事は、それぞれに数えます(合計は、全体より多くなることがあります)"),
  ];
}

function cornerBody(sl) {
  const rows = sourceRows(sl.sources, 5);
  return [
    h("h2", { class: "stage-title" }, sl.label),
    sl.intro ? h("p", { class: "stage-what" }, sl.intro) : null,
    sl.count ? h("p", { class: "stage-meta" }, `新着 ${sl.count} 件`) : null,
    figureOrNull(rows, "出どころ別の件数"),
  ];
}

function itemBody(sl) {
  const links = h("div", { class: "stage-actions" });
  if (/^https?:\/\//i.test(sl.url)) {
    links.append(h("a", { class: "btn", href: sl.url, target: "_blank", rel: "noopener noreferrer" }, "原文へ"));
  }
  if (sl.article) links.append(h("button", { class: "btn", type: "button", onclick: () => openDrawer(sl.article) }, "くわしく見る"));
  return [
    h("p", { class: "stage-meta" }, `${sl.corner} ${sl.n} / ${sl.of}`, sl.source ? h("span", { class: "badge" }, sl.source) : null, sl.ai ? aiBadge() : null),
    h("h2", { class: "stage-title" }, sl.heading),
    sl.what ? h("p", { class: "stage-what" }, sl.what) : null,
    sl.use ? h("p", { class: "stage-use" }, h("b", null, "分かること "), sl.use) : null,
    sl.term ? h("p", { class: "stage-term" }, h("b", null, `用語 ${sl.term.term}`), " ", sl.term.meaning) : null,
    links,
  ];
}

function recommendBody(sl) {
  return [
    h("p", { class: "stage-meta" }, "今日のおすすめ"),
    sl.heading ? h("h2", { class: "stage-title" }, sl.heading) : null,
    sl.what ? h("p", { class: "stage-what" }, sl.what) : null,
    sl.use ? h("p", { class: "stage-use" }, h("b", null, "読むと "), sl.use) : null,
    sl.apply ? h("p", { class: "stage-use" }, h("b", null, "たとえば "), sl.apply) : null,
    sl.projects?.length ? h("p", { class: "stage-meta" }, `関係しそうなプロジェクト: ${sl.projects.join("、")}`) : null,
  ];
}

function termBody(sl) {
  return [
    h("p", { class: "stage-meta" }, "今日の用語ひとこと", aiBadge()),
    h("dl", { class: "stage-terms" }, ...sl.terms.flatMap((t) => [h("dt", null, t.term), h("dd", null, t.meaning)])),
  ];
}

function recapBody(sl, weekly) {
  const rows = trendRows(weekly?.data?.daily, dayLabel);
  return [
    h("p", { class: "stage-meta" }, "今日のおさらい"),
    h("ol", { class: "stage-points" }, ...sl.titles.map((t) => h("li", null, t))),
    hasFigureData(rows, 2) ? lineChart({ title: "この7日間の新着", rows, note: "日ごとの新着(URL単位)の件数です" }) : null,
  ];
}

function closeBody() {
  return [h("p", { class: "stage-what" }, "ご視聴ありがとうございました。気になった話題は、記事を開いて、ボードに入れておくと、あとで読み返せます。")];
}

const BODY = { open: openBody, corner: cornerBody, item: itemBody, recommend: recommendBody, term: termBody, recap: recapBody, close: closeBody };

/**
 * ステージを作る。
 * @param {{program: object, weekly?: object|null}} p  program: buildRadioProgram の結果。weekly: 週次 episode(7日間の推移の図に使う。無くてもよい)
 * @returns {{el: HTMLElement, update: (snap: object) => void}}
 */
export function buildStage({ program, weekly = null }) {
  const kicker = h("span", { class: "stage-kicker" }, "いま読んでいる話題");
  // 字幕: いま読んでいる部分の、表示用の文(読み上げ用の「読み」ではなく、正しい表記)。読んでいないときは隠す
  const caption = h("p", { class: "stage-caption", hidden: true });
  const progress = h("span", { class: "stage-progress num" });
  let body = h("div", { class: "stage-body" });
  const el = h("section", { class: "stage", "aria-label": "いま読んでいる話題(画面)" }, h("div", { class: "stage-head" }, kicker, progress), caption, body);

  const idleSlide = program.corners[0]?.parts?.[0]?.slide ?? null;
  let shown = Symbol("none");

  const render = (slide, idle) => {
    const next = h("div", { class: "stage-body fade" });
    if (idle) {
      next.append(
        h("p", { class: "stage-hint" }, "「番組を再生」を押すと、ここに、いま読んでいる話題が出ます。"),
        ...(idleSlide ? openBody(idleSlide) : []),
      );
    } else {
      next.append(...(BODY[slide.kind]?.(slide, weekly) ?? []).filter(Boolean));
    }
    body.replaceWith(next);
    body = next;
  };

  const update = (snap) => {
    const mine = snap.status !== "idle" && snap.title === program.title && snap.slide;
    const key = mine ? snap.slide : null;
    progress.textContent = mine ? `${snap.chapterIndex + 1} / ${snap.chapterCount}` : "";
    kicker.textContent = mine ? snap.chapter : "いま読んでいる話題";
    const cap = mine ? (snap.caption ?? "") : "";
    if (caption.textContent !== cap) caption.textContent = cap;
    caption.hidden = !cap;
    if (key === shown) return; // 同じ画面のときは描き直さない(ちらつかせない)
    shown = key;
    render(key, !mine);
  };
  update({ status: "idle" });
  return { el, update };
}
