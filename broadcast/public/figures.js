// 図(SVG)の描画。週次・ラジオ・ホームで共有する。
// 図は、すべて実データ(収集した件数)から機械的に描く。AI が作った内容は含まない(誤りが混じらない)。
// 文字は textContent のみ(svg() が text ノードで作る)。色・太さは CSS(.fig)で決める(インラインの style は使わない)。

import { h, reduceMotion, svg } from "./util.js";
import { cleanup } from "./store.js";

/** 横棒グラフ。rows: [{label, value, cls?}]。 */
export function barChart({ title, rows, note }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fig = h("figure", { class: "fig" }, h("h3", null, title));
  const W = 560, rowH = 30, left = 150, right = 44;
  const H = rows.length * rowH + 6;
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}: ${rows.map((r) => `${r.label} ${r.value}件`).join("、")}` });
  rows.forEach((r, i) => {
    const w = ((W - left - right) * r.value) / max;
    const y = i * rowH + 4;
    chart.append(
      svg("text", { x: 0, y: y + 15 }, r.label),
      svg("rect", { class: `bar ${r.cls ?? "total"}`, x: left, y, width: Math.max(w, r.value ? 1 : 0), height: 20, rx: 3 }),
      svg("text", { class: "val", x: left + w + 6, y: y + 15 }, String(r.value)),
    );
  });
  fig.append(chart);
  if (note) fig.append(h("p", { class: "fig-note" }, note));
  return fig;
}

/** 日別の推移の折れ線。見えたときに、線が引かれる(1回。reduced-motion では最初から全部)。 */
export function lineChart({ title, rows, note }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fig = h("figure", { class: "fig" }, h("h3", null, title));
  const W = 560, H = 190, left = 24, right = 24, top = 24, bottom = 28;
  const step = rows.length > 1 ? (W - left - right) / (rows.length - 1) : 0;
  const pts = rows.map((r, i) => ({
    x: left + i * step,
    y: top + (H - top - bottom) * (1 - r.value / max),
    ...r,
  }));
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}: ${rows.map((r) => `${r.label} ${r.value}件`).join("、")}` });
  chart.append(svg("line", { class: "axis", x1: left, x2: W - right, y1: H - bottom, y2: H - bottom }));

  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const path = svg("path", {
    class: "line",
    d: pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" "),
    "stroke-dasharray": String(Math.ceil(len) + 2),
  });
  path.style.setProperty("--len", String(Math.ceil(len) + 2));
  chart.append(path);
  for (const p of pts) {
    chart.append(
      svg("circle", { class: "pt", cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.5 }),
      svg("text", { class: "val", x: p.x.toFixed(1), y: (p.y - 9).toFixed(1), "text-anchor": "middle" }, String(p.value)),
      svg("text", { x: p.x.toFixed(1), y: H - 8, "text-anchor": "middle" }, p.label),
    );
  }
  fig.append(chart);
  if (note) fig.append(h("p", { class: "fig-note" }, note));

  if (!reduceMotion && "IntersectionObserver" in window) {
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        path.classList.add("draw");
        obs.disconnect();
      }
    });
    obs.observe(fig);
    cleanup.push(() => obs.disconnect());
  }
  return fig;
}

/** 今週よく出た語と、先週との差。新出(先週は無かった語)と、増えた語を目立たせる。語を押すと検索へ。 */
