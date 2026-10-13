// Research Broadcast — ページ: 設定(ウォッチワード・関連プロジェクト・非表示の収集元・ショートカット)
//
// 設定はサーバー(D1)に保存するので、端末をまたいで同じになる。「既読を隠す」だけは、この端末の設定。

import { api, getHideRead, loadPrefs, savePref, setHideRead, state } from "./store.js";
import { crumbs, h, mount, renderSkeleton, toast } from "./util.js";

const SHORTCUTS = [
  ["j / k", "次・前の記事へ"],
  ["o", "記事の詳細を開く"],
  ["x", "既読 ⇄ 未読"],
  ["X(Shift + x)", "表示中の未読を、すべて既読に"],
  ["u", "既読を隠す ⇄ 表示する"],
  ["/", "検索"],
  ["g → h / r / b / w / p / s", "放送 / ラジオ / ボード / 特集 / レポート / 設定へ"],
  ["?", "ショートカットの一覧"],
  ["Esc", "詳細・一覧を閉じる"],
];

export async function pageSettings(view) {
  mount(view, renderSkeleton());
  await loadPrefs(true);
  const sources = (await api("/api/sources")).sources;
  render(view, sources);
}

function render(view, sources) {
  const save = async (key, value, okMsg) => {
    try {
      await savePref(key, value);
      toast(okMsg);
      render(view, sources);
    } catch {
      toast("保存できませんでした。入力を確認してください", true);
    }
  };

  // --- ウォッチワード
  const wwInput = h("input", { type: "text", class: "note-input", maxlength: "40", placeholder: "例: Houdini", "aria-label": "ウォッチワード" });
  const watch = h(
    "section",
    { class: "panel" },
    h("h2", null, "ウォッチワード"),
    h("p", { class: "sub" }, "この語を含む記事の、直近7日の件数をホームに出します(10個まで)。"),
    h(
      "div",
      { class: "source-chips" },
      ...state.prefs.watchwords.map((w) =>
        h(
          "button",
          {
            class: "chip",
            type: "button",
            title: "クリックで削除",
            onclick: () => save("watchwords", state.prefs.watchwords.filter((x) => x !== w), `「${w}」を削除しました`),
          },
          `${w}  ×`,
        ),
      ),
    ),
    h(
      "form",
      {
        class: "search-form",
        onsubmit: (ev) => {
          ev.preventDefault();
          const v = wwInput.value.trim();
          if (v) save("watchwords", [...state.prefs.watchwords, v], `「${v}」を追加しました`);
        },
      },
      wwInput,
      h("button", { class: "btn", type: "submit" }, "追加"),
    ),
  );

  // --- 関連プロジェクト
  const pName = h("input", { type: "text", class: "note-input", maxlength: "40", placeholder: "プロジェクト名(例: 卒論)", "aria-label": "プロジェクト名" });
  const pKeys = h("input", { type: "text", class: "note-input", placeholder: "キーワード(カンマ区切り。例: RAG, MCP, Houdini)", "aria-label": "キーワード" });
  const projects = h(
    "section",
    { class: "panel" },
    h("h2", null, "関連プロジェクト"),
    h("p", { class: "sub" }, "題名・要約にキーワードが含まれる記事に、「# プロジェクト名」のバッジを付けます(12個まで)。"),
    h(
      "ul",
      { class: "plain-list" },
      ...state.prefs.projects.map((p) =>
        h(
          "li",
          null,
          h("b", null, p.name),
          h("span", { class: "tool-note" }, ` — ${p.keywords.join(", ")}`),
          h(
            "button",
            {
              class: "chip",
              type: "button",
              onclick: () => save("projects", state.prefs.projects.filter((x) => x.name !== p.name), `「${p.name}」を削除しました`),
            },
            "削除",
          ),
        ),
      ),
    ),
    h(
      "form",
      {
        class: "stack-form",
        onsubmit: (ev) => {
          ev.preventDefault();
          const name = pName.value.trim();
          const keywords = pKeys.value.split(/[,、]/).map((k) => k.trim()).filter(Boolean);
          if (!name || !keywords.length) return toast("名前とキーワードを入力してください", true);
          const rest = state.prefs.projects.filter((x) => x.name !== name);
          save("projects", [...rest, { name, keywords }], `「${name}」を保存しました`);
        },
      },
      pName,
      pKeys,
      h("button", { class: "btn", type: "submit" }, "保存"),
    ),
  );

  // --- 非表示の収集元
  const muted = new Set(state.prefs.muted_sources);
  const mutedPanel = h(
    "section",
    { class: "panel" },
    h("h2", null, "非表示の収集元"),
    h("p", { class: "sub" }, "チェックした収集元の記事は、一覧・カテゴリページに出しません(件数の表示は変わりません)。"),
    h(
      "ul",
      { class: "plain-list cols" },
      ...sources.map((s) =>
        h(
          "li",
          null,
          h(
            "label",
            null,
            h("input", {
              type: "checkbox",
              checked: muted.has(s.platform),
              onchange: (ev) => {
                const next = new Set(state.prefs.muted_sources);
                if (ev.target.checked) next.add(s.platform);
                else next.delete(s.platform);
                save("muted_sources", [...next], ev.target.checked ? `「${s.platform}」を非表示にしました` : `「${s.platform}」を表示します`);
              },
            }),
            ` ${s.platform} `,
            h("span", { class: "badge" }, String(s.n)),
          ),
        ),
      ),
    ),
  );

  // --- この端末の表示
  const hide = h("input", {
    type: "checkbox",
    checked: getHideRead(),
    onchange: (ev) => {
      setHideRead(ev.target.checked);
      document.getElementById("hide-read-btn")?.setAttribute("aria-pressed", String(ev.target.checked));
    },
  });
  const device = h(
    "section",
    { class: "panel" },
    h("h2", null, "この端末の表示"),
    h("label", null, hide, " 既読の記事を隠す(薄く表示する代わりに、一覧から消す)"),
  );

  const keys = h(
    "section",
    { class: "panel" },
    h("h2", null, "キーボードショートカット"),
    h("dl", { class: "kv" }, ...SHORTCUTS.flatMap(([k, v]) => [h("dt", { class: "mono" }, k), h("dd", null, v)])),
  );

  mount(view, crumbs(h("a", { href: "/", "data-link": "" }, "放送"), "設定"), h("h1", null, "設定"), watch, projects, mutedPanel, device, keys);
}
