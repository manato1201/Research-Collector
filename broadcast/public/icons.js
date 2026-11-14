// Research Broadcast — 線のアイコン一式(1 つの書き方にそろえる)
//
// 規則: 24×24 の座標・線の太さ 1.8・角と端は丸く・色は currentColor(テーマに従う)。
// 放送の印(点 + 弧 2 本。favicon と同じ)を、アイコン全体の言葉にする。
// 文字は消さない: アイコンは文字の横に添える(色や形だけに頼らない)。ボタンの名前は文字が持つ。
// このファイルは DOM に触れない(import しても何も起きない)。描画は icon() / decorate() を呼んだときだけ。

/** [タグ, 属性] の並び。 */
export const ICONS = {
  // ナビゲーション
  broadcast: [["circle", { cx: 12, cy: 12, r: 2 }], ["path", { d: "M7.8 7.8a6 6 0 0 0 0 8.4" }], ["path", { d: "M16.2 7.8a6 6 0 0 1 0 8.4" }], ["path", { d: "M4.9 4.9a10 10 0 0 0 0 14.2" }], ["path", { d: "M19.1 4.9a10 10 0 0 1 0 14.2" }]],
  radio: [["rect", { x: 3, y: 8, width: 18, height: 12, rx: 2 }], ["path", { d: "M7 8l10-5" }], ["circle", { cx: 9, cy: 14, r: 2.5 }], ["path", { d: "M15 12.5h3M15 16h3" }]],
  board: [["rect", { x: 3, y: 4, width: 5, height: 16, rx: 1 }], ["rect", { x: 9.5, y: 4, width: 5, height: 10, rx: 1 }], ["rect", { x: 16, y: 4, width: 5, height: 13, rx: 1 }]],
  tidy: [["path", { d: "M7 4h10" }], ["rect", { x: 4, y: 8, width: 16, height: 12, rx: 2 }], ["path", { d: "M9 14l2 2 4-4" }]],
  weekly: [["path", { d: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" }]],
  reports: [["path", { d: "M7 3h7l5 5v13H7z" }], ["path", { d: "M14 3v5h5M10 13h6M10 17h6" }]],
  status: [["path", { d: "M3 12h4l2-6 4 12 2-6h6" }]],
  settings: [["path", { d: "M4 7h10M18 7h2M4 17h2M10 17h10" }], ["circle", { cx: 16, cy: 7, r: 2 }], ["circle", { cx: 8, cy: 17, r: 2 }]],
  // 操作
  search: [["circle", { cx: 11, cy: 11, r: 6 }], ["path", { d: "M20 20l-4.2-4.2" }]],
  "eye-off": [["path", { d: "M3 3l18 18" }], ["path", { d: "M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.7 3.4M6.3 7.6A13 13 0 0 0 2.5 12c1 2 4.5 6 9.5 6 1.2 0 2.3-.2 3.3-.6" }]],
  help: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2.9-1.2 1.8" }], ["circle", { cx: 12, cy: 17, r: 0.6 }]],
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }]],
  moon: [["path", { d: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" }]],
  close: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7" }]],
  alert: [["path", { d: "M12 4l9 16H3z" }], ["path", { d: "M12 10v4" }], ["circle", { cx: 12, cy: 17, r: 0.6 }]],
  // プレーヤー
  prev: [["path", { d: "M6 5v14" }], ["path", { d: "M19 5l-9 7 9 7z" }]],
  next: [["path", { d: "M18 5v14" }], ["path", { d: "M5 5l9 7-9 7z" }]],
  play: [["path", { d: "M7 4l13 8-13 8z" }]],
  pause: [["path", { d: "M8 5v14M16 5v14" }]],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }]],
};

const NS = "http://www.w3.org/2000/svg";

/** アイコンの SVG を作る。名前が無ければ null(呼び出し側は文字だけで動く)。 */
export function icon(name, extraClass = "") {
  const parts = ICONS[name];
  if (!parts) return null;
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("class", `ico ico-${name}${extraClass ? ` ${extraClass}` : ""}`);
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("focusable", "false");
  for (const [tag, attrs] of parts) {
    const child = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    el.append(child);
  }
  return el;
}

/** 要素の中身を「アイコン + 文字」にする。文字は span.lbl に入れる(狭い画面で、文字だけ隠せるように)。 */
export function setLabel(el, name, text) {
  const ico = icon(name);
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = text;
  el.replaceChildren(...(ico ? [ico, lbl] : [lbl]));
}

/** data-icon を持つ要素(固定の HTML)に、アイコンを足す。すでに足してあれば何もしない。 */
export function decorate(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    if (el.querySelector(":scope > .ico")) continue;
    const names = el.dataset.icon.split(/\s+/).filter(Boolean);
    const text = el.textContent.trim();
    const icons = names.map((n) => icon(n)).filter(Boolean);
    if (!icons.length) continue;
    if (text) {
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = text;
      el.replaceChildren(...icons, lbl);
    } else {
      el.replaceChildren(...icons);
    }
  }
}
