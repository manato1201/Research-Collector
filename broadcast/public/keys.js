// Research Broadcast — キーボード操作
//
//   j / k   次・前の記事へ移動(フォーカス)   o / Enter  記事の詳細を開く
//   x       既読 ⇄ 未読                        u          「既読を隠す」の切り替え
//   /       検索へ                             g h / g r / g b / g s  放送 / ラジオ / ボード / 設定へ
//   ?       この一覧を表示 / 閉じる            Esc        閉じる
//
// 入力欄・選択肢・ドロワーの中では、文字入力を妨げない(入力欄では何もしない。ドロワーは Esc だけ)。

import { itemData, markAllRead, openDrawer, setBoard } from "./components.js";
import { navigate } from "./router.js";
import { getHideRead, setHideRead, state } from "./store.js";
import { toast } from "./util.js";

let pendingG = 0; // "g" を押した時刻(ms)。続けて押すと移動

const typing = (el) =>
  el instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);

function items() {
  return [...document.querySelectorAll("#view .item")].filter((li) => li.offsetParent !== null);
}

function currentIndex(list) {
  const active = document.activeElement?.closest?.(".item");
  return active ? list.indexOf(active) : -1;
}

function focusItem(li) {
  li.querySelector(".item-title")?.focus({ preventScroll: false });
  li.scrollIntoView({ block: "nearest" });
}

function toggleHelp(force) {
  const box = document.getElementById("help");
  if (!box) return;
  const show = force ?? box.hidden;
  box.hidden = !show;
  if (show) box.querySelector("button")?.focus();
}

export function initKeys() {
  document.getElementById("help-close")?.addEventListener("click", () => toggleHelp(false));
  document.getElementById("help-open")?.addEventListener("click", () => toggleHelp(true));

  document.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const help = document.getElementById("help");
    if (ev.key === "Escape" && help && !help.hidden) {
      toggleHelp(false);
      return;
    }
    if (typing(ev.target)) return;
    if (!document.getElementById("drawer").hidden) return; // ドロワーの中は Esc(components 側)だけ

    const k = ev.key;
    const now = Date.now();

    if (pendingG && now - pendingG < 900) {
      pendingG = 0;
      const dest = { h: "/", r: "/radio", b: "/board", s: "/settings", w: "/weekly", p: "/reports" }[k];
      if (dest) {
        ev.preventDefault();
        navigate(dest);
        return;
      }
    }
    pendingG = 0;

    if (k === "g") {
      pendingG = now;
      return;
    }
    if (k === "?") {
      ev.preventDefault();
      toggleHelp();
      return;
    }
    if (k === "/") {
      ev.preventDefault();
      document.getElementById("search-input")?.focus();
      return;
    }
    if (k === "u") {
      const next = !getHideRead();
      setHideRead(next);
      document.getElementById("hide-read-btn")?.setAttribute("aria-pressed", String(next));
      toast(next ? "既読を隠します" : "既読も表示します");
      return;
    }

    const list = items();
    if (!list.length) return;
    const i = currentIndex(list);

    if (k === "j" || k === "k") {
      ev.preventDefault();
      const next = k === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
      focusItem(list[next]);
      return;
    }
    if ((k === "o" || k === "Enter") && i >= 0) {
      const a = itemData.get(list[i]);
      if (a && k === "o") {
        ev.preventDefault();
        openDrawer(a);
      }
      return; // Enter は、フォーカス中のボタン(記事の題名)の標準の動作に任せる
    }
    if (k === "x" && i >= 0) {
      const a = itemData.get(list[i]);
      if (!a) return;
      ev.preventDefault();
      const cur = state.board.get(a.url_hash)?.state;
      // 既読 → 未読 / 未読 → 既読。読む・試す・保留 の記事は、そのまま触らない
      if (cur === "read") setBoard(a, "unread", "", () => {});
      else if (!cur) setBoard(a, "read", "", () => {});
      else toast("「読む / 試す / 保留」の記事は、詳細から変更してください");
      return;
    }
    if (k === "X") {
      ev.preventDefault();
      markAllRead(list.map((li) => itemData.get(li)).filter(Boolean));
    }
  });
}
