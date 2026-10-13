// Research Broadcast — ページ: 検索(全文検索)
//
// 3文字以上の語は全文検索(FTS5 trigram。日本語も部分一致)、短い語は LIKE。空白で区切った語は、すべてを含む記事。
// 検索語は、ウォッチワードとして保存できる(保存すると、ホームに直近7日の件数が出る)。

import { itemsToChapters, readButton, renderItem } from "./components.js";
import { navigate } from "./router.js";
import { api, loadBoard, savePref, state } from "./store.js";
import { crumbs, fadeIn, h, mount, renderEmpty, renderSkeleton, toast } from "./util.js";

export async function pageSearch(view, params) {
  const q = (params.get("q") ?? "").trim();

  const input = h("input", {
    type: "search",
    class: "note-input",
    value: q,
    placeholder: "語で探す(空白区切りは、すべてを含む)",
    "aria-label": "検索語",
    maxlength: "60",
  });
  const form = h(
    "form",
    {
      class: "search-form",
      role: "search",
      onsubmit: (ev) => {
        ev.preventDefault();
        const v = input.value.trim();
        if (v) navigate(`/search?q=${encodeURIComponent(v)}`);
      },
    },
    input,
    h("button", { class: "btn primary", type: "submit" }, "検索"),
  );

  if (!q) {
    mount(
      view,
      crumbs(h("a", { href: "/", "data-link": "" }, "放送"), "検索"),
      h("h1", null, "記事を", h("em", null, "検索")),
      form,
      renderEmpty("語を入力してください", "題名と要約から探します。保存した語(ウォッチワード)は、ホームに新着の件数が出ます。"),
    );
    input.focus();
    return;
  }

  mount(view, renderSkeleton());
  const [res] = await Promise.all([api(`/api/search?q=${encodeURIComponent(q)}&limit=100`), loadBoard()]);
  const saved = state.prefs.watchwords.includes(q);

  const saveBtn = h(
    "button",
    {
      class: "btn",
      type: "button",
      disabled: saved,
      onclick: async (ev) => {
        try {
          await savePref("watchwords", [...state.prefs.watchwords, q]);
          ev.currentTarget.disabled = true;
          ev.currentTarget.textContent = "ウォッチワードに保存しました";
        } catch {
          toast("保存できませんでした(ウォッチワードは10個までです)", true);
        }
      },
    },
    saved ? "ウォッチワードに保存済み" : "この語をウォッチワードに保存",
  );

  const articles = res.articles.map((a) => ({ ...a, other_categories: [] }));
  mount(
    view,
    crumbs(h("a", { href: "/", "data-link": "" }, "放送"), "検索"),
    h("h1", null, "記事を", h("em", null, "検索")),
    form,
    h(
      "p",
      { class: "sub" },
      h("span", { class: "num" }, String(articles.length)),
      `件 ・ ${res.mode === "fts" ? "全文検索" : "短い語のため部分一致"}`,
      articles.length >= 100 ? "(新しい順に100件まで)" : "",
    ),
    h("div", { class: "row-controls" }, saveBtn, readButton("結果を読み上げ", `検索: ${q}`, () => itemsToChapters(articles, 15))),
    articles.length
      ? h("ul", { class: "list" }, ...articles.map((a) => renderItem(a)))
      : renderEmpty("見つかりませんでした", "語を変えるか、短くしてみてください。"),
  );
  fadeIn([...view.querySelectorAll(".item")].slice(0, 10));
}
