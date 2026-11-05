// Research Broadcast — ページ: ボード
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { fadeIn, h, jstToday, mount, renderSkeleton, toast } from "./util.js";
import { AuthError, BOARD_LABELS, BOARD_ORDER, allCategoryIds, api, catLabel, excludeParam, loadMarks, state } from "./store.js";
import { renderItem, renderMarkItems } from "./components.js";
import { navigate } from "./router.js";

// ------------------------------------------------------------------ ページ: ボード

// ------------------------------------------------------------------ 書き出し・読み込み(JSON)

const BOARD_FILE_KIND = "research-broadcast-board";
const IMPORT_MAX = 500; // サーバーの上限(BOARD_IMPORT_MAX)と同じ
const IMPORT_STATES = ["reading", "try", "hold", "read"];

/** ボードの全件(読む / 試す / 保留 / 既読)を、人が読める JSON にして端末へ保存する。 */
export function exportBoard(items) {
  const data = {
    schema: 1,
    kind: BOARD_FILE_KIND,
    exported_at: new Date().toISOString(),
    items: items.map((i) => ({
      url_hash: i.url_hash,
      state: i.state,
      note: i.note ?? "",
      updated_at: i.updated_at,
      title: i.article?.title ?? null,
      url: i.article?.url ?? null,
    })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  // h() の href は http(s) だけを通す(安全のため)。自分で作った blob: の URL は、直接設定する
  const a = h("a", { download: `research-broadcast-board-${jstToday()}.json` });
  a.href = url;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 書き出したファイルの中身を検査し、サーバーへ送る形にする。形が違えば { error } を返す(一部だけ読み込むことはしない)。 */
export function parseBoardFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "JSON として読めませんでした" };
  }
  if (data?.kind !== BOARD_FILE_KIND || !Array.isArray(data.items)) return { error: "このサイトの書き出しファイルではありません" };
  if (data.items.length === 0) return { error: "ファイルに記事がありません" };
  if (data.items.length > IMPORT_MAX) return { error: `一度に読み込めるのは${IMPORT_MAX}件までです` };
  const items = [];
  for (const it of data.items) {
    if (!/^[0-9a-f]{16}$/.test(it?.url_hash ?? "") || !IMPORT_STATES.includes(it?.state)) return { error: "形式が正しくない項目があります" };
    const note = typeof it.note === "string" ? it.note : "";
    if (note.length > 200) return { error: "メモが長すぎる項目があります" };
    items.push({ url_hash: it.url_hash, state: it.state, note });
  }
  return { items };
}

function boardTransfer(items, overwriteBox) {
  const input = h("input", { type: "file", accept: "application/json,.json", hidden: true, "aria-label": "読み込むファイル" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const parsed = parseBoardFile(await file.text());
    if (parsed.error) return toast(`読み込めません: ${parsed.error}`, true);
    const overwrite = overwriteBox.checked;
    const msg = overwrite
      ? `${parsed.items.length}件を読み込みます。すでにボードにある記事は、ファイルの内容で上書きされます。よろしいですか?`
      : `${parsed.items.length}件を読み込みます。すでにボードにある記事は、そのままにします(上書きしません)。よろしいですか?`;
    if (!window.confirm(msg)) return;
    try {
      const r = await api("/api/board/import", { method: "POST", body: { items: parsed.items, overwrite } });
      toast(overwrite ? `${r.added}件を追加し、${r.updated}件を上書きしました` : `${r.added}件を追加しました(既存の${r.existing}件は変更なし)`);
      navigate(`${location.pathname}${location.search}`);
    } catch (err) {
      if (err instanceof AuthError) return navigate("/login");
      toast("読み込めませんでした。時間をおいてやり直してください", true);
    }
  });
  return h(
    "div",
    { class: "row-controls", role: "group", "aria-label": "ボードの書き出し・読み込み" },
    h("button", { class: "btn", type: "button", disabled: items.length === 0, onclick: () => exportBoard(items) }, "書き出す(JSON)"),
    h("button", { class: "btn", type: "button", onclick: () => input.click() }, "読み込む"),
    h("label", { class: "player-check" }, overwriteBox, " 既存の状態も上書きする"),
    input,
  );
}

export async function pageBoard(view, params) {
  mount(view, renderSkeleton());
  // 未読の件数(整理の入口に使う)。取れなくても、ボードは表示する
  const [data, , tidy] = await Promise.all([
    api("/api/board"),
    loadMarks(true),
    api(`/api/tidy?days=7&limit=0${excludeParam()}`).catch((e) => (e instanceof AuthError ? Promise.reject(e) : null)),
  ]);
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

  // ピン留め・見直す日(整理で付ける。ボードの状態とは別)。カテゴリの絞り込みにも従う
  const inCat = (e) => !catFilter || (e.article?.categories ?? []).includes(catFilter);
  const reminders = state.markList.filter((e) => e.remind_on && inCat(e)); // 見直す日の早い順(サーバーが並べる)
  const pins = state.markList.filter((e) => e.pinned && inCat(e));
  const markSection = (id, title, hint, entries) =>
    h(
      "section",
      { class: "panel", "aria-labelledby": id },
      h("h2", { id }, title, h("span", { class: "lane-count num" }, String(entries.length))),
      h("p", { class: "sub" }, hint),
      renderMarkItems(entries),
    );

  // 件数のまとめ(未読は、整理の API から。取れなければ出さない)
  const countOf = (s) => data.items.filter((i) => i.state === s).length;
  const summary = h(
    "p",
    { class: "tidy-stats", "aria-label": "件数" },
    tidy ? ["未読 ", h("b", { class: "num" }, String(tidy.unread)), " ・ "] : null,
    ...["reading", "try", "hold", "read"].flatMap((s, i) => [i ? " ・ " : null, `${BOARD_LABELS[s]} `, h("b", { class: "num" }, String(countOf(s)))]),
    " ・ ピン ",
    h("b", { class: "num" }, String(state.markList.filter((e) => e.pinned).length)),
    " ・ 見直し予定 ",
    h("b", { class: "num" }, String(state.markList.filter((e) => e.remind_on).length)),
  );
  const tidyLink = h(
    "a",
    { class: "btn", href: "/tidy", "data-link": "" },
    tidy && tidy.stale > 0 ? `整理する(7日以上の未読 ${tidy.stale}件)` : "整理を開く",
  );

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
    summary,
    h("div", { class: "row-controls" }, tidyLink),
    h("div", { class: "lanes" }, ...BOARD_ORDER.map(lane)),
    reminders.length
      ? markSection(
          "board-remind",
          "見直し",
          "見直す日を決めた記事です。日付になると「見直し」と出ます(通知は出ません)。",
          reminders,
        )
      : null,
    pins.length ? markSection("board-pin", "ピン留め", "整理の候補から外して、残している記事です。", pins) : null,
    h("h2", { class: "guide-title" }, "持ち出し"),
    h(
      "p",
      { class: "sub" },
      `ボードの状態(読む・試す・保留・既読。最大${IMPORT_MAX}件)を、JSON で書き出し・読み込みできます。読み込みでは、すでにある状態を黙って上書きしません。`,
    ),
    boardTransfer(data.items, h("input", { type: "checkbox", id: "import-overwrite" })),
  );
  fadeIn([...view.querySelectorAll(".lane")]);
}
