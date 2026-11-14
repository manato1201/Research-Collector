// Research Broadcast — ページ: 整理(しばらく開いていない未読を、1件ずつ片づける)
//
// 外部資料 第5弾 Z35 の「溜まった記事を減らす手順」。ここでの操作は、すべて既存の仕組みに乗る:
//   完了      = ボードの「既読」        ピン留め  = 整理の候補から外して残す(marks)
//   見直す日  = その日から「見直し」に出る(marks。通知は出さない)       今は決めない = 何も付けず、未読のまま残す
// 操作は、ボタン・キー(← → ↓ 1 2 3 z)・カードのスワイプ(左=完了 / 右=ピン)のどれでもできる。
// スワイプは近道で、ボタンで同じことができる。動きを減らす設定では、カードは動かさず(ドラッグの追従だけ)、戻りの動きも付けない。

import { h, mount, renderEmpty, renderSkeleton, shortDate, toast } from "./util.js";
import { AuthError, REMIND_CHOICES, TIDY_DAYS, api, applyMark, catLabel, cleanup, excludeParam, loadBoard, remindDate, state } from "./store.js";
import { openDrawer } from "./components.js";
import { navigate } from "./router.js";

const SWIPE_PX = 90; // これ以上横に動かして離すと、操作になる
const HISTORY_MAX = 50;

const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

const typing = (el) => el instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);

/** カードを横にドラッグ(指・ポインタ)して離したら、左 = onLeft / 右 = onRight。縦のスクロールは妨げない(CSS の touch-action: pan-y)。 */
function attachSwipe(card, onLeft, onRight) {
  let startX = null;
  let startY = 0;
  let dx = 0;
  let pid = null;
  const reset = () => {
    startX = null;
    dx = 0;
    card.style.transform = "";
    delete card.dataset.swipe;
  };
  card.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (ev.target instanceof Element && ev.target.closest("button, a, select, input")) return;
    startX = ev.clientX;
    startY = ev.clientY;
    dx = 0;
    pid = ev.pointerId;
  });
  card.addEventListener("pointermove", (ev) => {
    if (startX === null || ev.pointerId !== pid) return;
    dx = ev.clientX - startX;
    // 縦に動かしているだけなら、横の操作とは見なさない(スクロールを優先する)
    if (Math.abs(dx) < 12 && Math.abs(ev.clientY - startY) > 12) return reset();
    if (Math.abs(dx) > 12) card.setPointerCapture?.(ev.pointerId);
    card.style.transform = `translateX(${Math.max(-160, Math.min(160, dx))}px)`;
    card.dataset.swipe = dx >= SWIPE_PX ? "right" : dx <= -SWIPE_PX ? "left" : dx > 12 ? "right-soft" : dx < -12 ? "left-soft" : "";
  });
  card.addEventListener("pointerup", (ev) => {
    if (startX === null || ev.pointerId !== pid) return;
    const moved = dx;
    reset();
    if (moved <= -SWIPE_PX) onLeft();
    else if (moved >= SWIPE_PX) onRight();
  });
  card.addEventListener("pointercancel", reset);
}

export async function pageTidy(view, params) {
  mount(view, renderSkeleton());
  const days = TIDY_DAYS.includes(Number(params.get("d"))) ? Number(params.get("d")) : 7;
  const [data] = await Promise.all([api(`/api/tidy?days=${days}&limit=200${excludeParam()}`), loadBoard()]);

  const queue = [...data.articles]; // 古い順。先頭が、いま出しているカード
  const history = []; // 取り消し用。{ kind: read|pin|remind|skip|bulk, article?, articles? }
  let busy = false;

  const tally = () => {
    const t = { read: 0, pin: 0, remind: 0, skip: 0 };
    for (const e of history) {
      if (e.kind === "bulk") t.read += e.articles.length;
      else t[e.kind] += 1;
    }
    return t;
  };

  // ---- 見出し・日数の切り替え
  const chips = h(
    "div",
    { class: "row-controls", role: "group", "aria-label": "何日以上たった未読を整理するか" },
    ...TIDY_DAYS.map((d) =>
      h(
        "button",
        { class: "chip", type: "button", "data-days": String(d), "aria-pressed": String(d === days), onclick: () => navigate(`/tidy?d=${d}`) },
        `${d}日以上`,
        h("span", { class: "n" }, String(data.buckets?.[String(d)] ?? 0)),
      ),
    ),
  );
  const stats = h("p", { class: "tidy-stats", role: "status" });
  const cardBox = h("div", { class: "tidy-stage", "aria-live": "polite" });

  // ---- 操作ボタン(最初に1回だけ作る。カードを替えても、フォーカスが外れない)
  const btn = (label, kbd, onclick, extra = {}) =>
    h(
      "button",
      {
        class: `btn${extra.primary ? " primary" : ""}`,
        type: "button",
        "aria-keyshortcuts": kbd || null,
        title: kbd ? `キー: ${kbd}` : null,
        onclick,
        ...extra.attrs,
      },
      label,
    );
  const bRead = btn("完了(既読)", "ArrowLeft", () => act("read"), { primary: true, attrs: { "data-act": "read" } });
  const bPin = btn("ピン留め", "ArrowRight", () => act("pin"), { attrs: { "data-act": "pin" } });
  const bRemind = REMIND_CHOICES.map(([, label, n], i) =>
    btn(`${label}に見直す`, String(i + 1), () => act("remind", n), { attrs: { "data-act": "remind", "data-n": String(n) } }),
  );
  const bSkip = btn("今は決めない", "ArrowDown", () => act("skip"), { attrs: { "data-act": "skip" } });
  const bUndo = btn("ひとつ戻す", "z", () => undo(), { attrs: { "data-act": "undo" } });
  const bBulk = btn("", "", () => bulkRead(), { attrs: { "data-act": "bulk" } });
  const actions = h("div", { class: "tidy-actions", role: "group", "aria-label": "このカードをどうするか" }, bRead, bPin, ...bRemind, bSkip);
  const extras = h("div", { class: "row-controls" }, bUndo, bBulk);

  // ---- 描画
  /** 処理中は、押せるボタンをすべて止める(カードは、そのまま)。 */
  function lock() {
    for (const b of [bRead, bPin, ...bRemind, bSkip, bUndo, bBulk]) b.disabled = true;
  }

  function render() {
    // ほかの場所(詳細の画面)で、すでにボードや目印が付いた記事は、整理の対象から外す
    while (queue.length && (state.board.has(queue[0].url_hash) || state.marks.has(queue[0].url_hash))) queue.shift();
    const t = tally();
    const left = Math.max(0, data.stale - t.read - t.pin - t.remind);
    stats.replaceChildren(
      `未読 ${data.unread - t.read - t.pin - t.remind}件のうち、${days}日以上たったもの `,
      h("b", { class: "num" }, String(left)),
      "件。 今回: 完了 ",
      h("b", { class: "num" }, String(t.read)),
      " ・ ピン ",
      h("b", { class: "num" }, String(t.pin)),
      " ・ 見直し ",
      h("b", { class: "num" }, String(t.remind)),
      t.skip ? ` ・ 今は決めない ${t.skip}` : "",
    );

    const has = queue.length > 0;
    for (const b of [bRead, bPin, ...bRemind, bSkip]) b.disabled = !has || busy;
    bUndo.disabled = history.length === 0 || busy;
    bBulk.disabled = !has || busy;
    bBulk.textContent = has ? `残り${queue.length}件を、まとめて既読にする` : "まとめて既読にする";
    actions.hidden = !has;

    if (!has) {
      cardBox.replaceChildren(finished(t));
      return;
    }
    const a = queue[0];
    const age = daysSince(a.collected_at);
    const card = h(
      "article",
      { class: "tidy-card", "aria-label": "整理するカード" },
      h("span", { class: "tidy-hint left", "aria-hidden": "true" }, "← 完了"),
      h("span", { class: "tidy-hint right", "aria-hidden": "true" }, "ピン →"),
      h(
        "p",
        { class: "tidy-meta" },
        h("span", { class: "num" }, `残り ${queue.length}件`),
        a.platform ? h("span", { class: "badge" }, a.platform) : null,
        ...(a.categories ?? []).map((c) => h("span", { class: "badge" }, catLabel(c))),
        h("span", { class: "badge warn" }, `${age}日前に収集`),
        h("time", { class: "mono" }, shortDate(a.published ?? a.collected_at ?? "")),
      ),
      h("h2", { class: "tidy-title" }, a.title),
      a.summary ? h("p", { class: "item-sum" }, a.summary) : h("p", { class: "item-sum dim" }, "(要約はありません)"),
      h(
        "div",
        { class: "row-controls" },
        h("button", { class: "btn", type: "button", onclick: () => openDrawer({ ...a, other_categories: [] }) }, "くわしく見る"),
        /^https?:\/\//i.test(a.url ?? "") ? h("a", { class: "btn", href: a.url, target: "_blank", rel: "noopener noreferrer" }, "原文へ") : null,
      ),
    );
    attachSwipe(card, () => act("read"), () => act("pin"));
    cardBox.replaceChildren(card);
  }

  function finished(t) {
    const handled = t.read + t.pin + t.remind;
    if (data.stale === 0) return renderEmpty("整理するものはありません", `収集して${days}日以上たった未読は、ありません。`);
    const more = data.stale > data.articles.length;
    return h(
      "div",
      { class: "empty" },
      h("b", null, handled > 0 ? "片づきました" : "ここまでです"),
      h(
        "span",
        null,
        `完了 ${t.read}件 ・ ピン ${t.pin}件 ・ 見直し ${t.remind}件` +
          (t.skip ? ` ・ 今は決めない ${t.skip}件(未読のまま残っています)` : ""),
      ),
      more
        ? h(
            "span",
            null,
            `古い順に${data.articles.length}件までを出していました。残りは、開き直すと出ます。 `,
            h("button", { class: "btn", type: "button", onclick: () => navigate(`/tidy?d=${days}`) }, "続きを読み込む"),
          )
        : null,
    );
  }

  // ---- 操作
  const fail = (err) => {
    if (err instanceof AuthError) return navigate("/auth-required");
    toast("更新できませんでした。時間をおいてやり直してください", true);
  };
  const push = (entry) => {
    history.push(entry);
    if (history.length > HISTORY_MAX) history.shift();
  };

  async function act(kind, n = 1) {
    if (busy || !queue.length) return;
    const a = queue[0];
    // 詳細の画面で、すでにボードに入れた・目印を付けた記事は、上書きしない
    if (kind !== "skip" && (state.board.has(a.url_hash) || state.marks.has(a.url_hash))) {
      toast("この記事は、すでにボードか目印に入っています");
      queue.shift();
      return render();
    }
    busy = true;
    lock();
    try {
      if (kind === "read") {
        await api(`/api/board/${a.url_hash}`, { method: "PUT", body: { state: "read", note: "" } });
        state.board.set(a.url_hash, { state: "read", note: "" });
      } else if (kind === "pin") {
        applyMark(a.url_hash, await api(`/api/marks/${a.url_hash}`, { method: "PUT", body: { pinned: true } }), a);
      } else if (kind === "remind") {
        applyMark(a.url_hash, await api(`/api/marks/${a.url_hash}`, { method: "PUT", body: { remind_on: remindDate(n) } }), a);
      }
      queue.shift();
      push({ kind, article: a });
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
      render();
    }
  }

  async function undo() {
    if (busy || !history.length) return;
    const last = history[history.length - 1];
    busy = true;
    lock();
    try {
      if (last.kind === "read") {
        await api(`/api/board/${last.article.url_hash}`, { method: "DELETE" });
        state.board.delete(last.article.url_hash);
      } else if (last.kind === "pin") {
        applyMark(last.article.url_hash, await api(`/api/marks/${last.article.url_hash}`, { method: "PUT", body: { pinned: false } }));
      } else if (last.kind === "remind") {
        applyMark(last.article.url_hash, await api(`/api/marks/${last.article.url_hash}`, { method: "PUT", body: { remind_on: null } }));
      } else if (last.kind === "bulk") {
        // 既読になっているものだけ戻す(まとめて既読にしたあと、詳細で「読む」などに替えた記事は触らない)
        await api("/api/board/bulk", { method: "POST", body: { hashes: last.articles.map((x) => x.url_hash), state: "unread", only: "read" } });
        for (const x of last.articles) if (state.board.get(x.url_hash)?.state === "read") state.board.delete(x.url_hash);
      }
      history.pop();
      queue.unshift(...(last.kind === "bulk" ? last.articles : [last.article]));
      toast("ひとつ戻しました");
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
      render();
    }
  }

  async function bulkRead() {
    if (busy || !queue.length) return;
    const targets = queue.filter((a) => !state.board.has(a.url_hash) && !state.marks.has(a.url_hash)).slice(0, 200);
    if (!targets.length) return;
    if (!window.confirm(`残り${targets.length}件を、まとめて既読にします(「ひとつ戻す」で、この操作を取り消せます)。よろしいですか?`)) return;
    busy = true;
    lock();
    try {
      await api("/api/board/bulk", { method: "POST", body: { hashes: targets.map((a) => a.url_hash), state: "read" } });
      for (const a of targets) state.board.set(a.url_hash, { state: "read", note: "" });
      queue.splice(0, queue.length, ...queue.filter((a) => !targets.includes(a)));
      push({ kind: "bulk", articles: targets });
      toast(`${targets.length}件を既読にしました`);
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
      render();
    }
  }

  // ---- キー(入力欄・詳細の画面・ショートカット一覧が開いているときは、何もしない)
  const onKey = (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return;
    if (!document.getElementById("drawer").hidden || !document.getElementById("help").hidden) return;
    const map = { ArrowLeft: () => act("read"), ArrowRight: () => act("pin"), ArrowDown: () => act("skip"), z: () => undo() };
    REMIND_CHOICES.forEach(([, , n], i) => (map[String(i + 1)] = () => act("remind", n)));
    const fn = map[ev.key];
    if (!fn) return;
    ev.preventDefault();
    fn();
  };
  document.addEventListener("keydown", onKey);
  cleanup.push(() => document.removeEventListener("keydown", onKey));

  mount(
    view,
    h("h1", null, "整理"),
    h(
      "p",
      { class: "sub" },
      "しばらく開いていない未読を、古いものから1件ずつ片づけます。決めなかったものは、未読のまま残ります。記事を消すことはありません。",
    ),
    chips,
    stats,
    cardBox,
    actions,
    extras,
    h(
      "p",
      { class: "tool-note" },
      "キー: ← 完了 ・ → ピン留め ・ ↓ 今は決めない ・ 1 / 2 / 3 = 明日 / 3日後 / 1週間後に見直す ・ z ひとつ戻す。カードは、左へスワイプで完了、右へスワイプでピン留めです。",
      " 見直す日は、ホームとボードに「見直し」として出ます(通知は出ません)。保持期間(90日)を過ぎた記事は、ピンを付けていても消えます。",
    ),
  );
  render();
}
