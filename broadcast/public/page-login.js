// Research Broadcast — ページ: ログイン
// (app.js から機械的に分割した。挙動は分割前と同じ。全体の方針は app.js の先頭を参照)

import { h, mount } from "./util.js";
import { AuthError, api, state } from "./store.js";
import { navigate, updateAuthUi } from "./router.js";

// ------------------------------------------------------------------ ページ: ログイン

export function pageLogin(view, params) {
  const err = h("p", { class: "err", role: "alert" });
  const input = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true, "aria-label": "パスワード" });
  const form = h(
    "form",
    {
      class: "login",
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = "";
        try {
          await api("/api/login", { method: "POST", body: { password: input.value } });
          state.session = { ...state.session, authenticated: true, via: "session" };
          state.boardLoaded = false;
          input.value = "";
          updateAuthUi();
          const next = params.get("next");
          navigate(next && next.startsWith("/") && !next.startsWith("//") && next !== "/login" ? next : "/");
        } catch (e) {
          err.textContent = e instanceof AuthError ? "パスワードが違います" : "ログインできませんでした。時間をおいてやり直してください";
          input.select();
        }
      },
    },
    h("h1", null, "ログイン"),
    h("label", { for: "pw" }, "閲覧用パスワード"),
    input,
    err,
    h("button", { class: "btn primary", type: "submit" }, "ログイン"),
  );
  input.id = "pw";
  mount(view, form);
  input.focus();
}
