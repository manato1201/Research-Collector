// 図に渡す行(rows)の整形。DOM に依存しない純粋な関数(node でテストできる)。
// 元になるのは、その日・その週の episode の件数だけ。ここで数字を足したり、推測したりしない。

/** 分野別の件数 → 棒グラフの行。複数の分野にまたがる記事は、それぞれに数えられる(合計は全体より多くなりうる)。 */
export function categoryRows(byCategory, labelOf) {
  return Object.entries(byCategory ?? {}).map(([id, n]) => ({ label: labelOf(id), value: Number(n) || 0, cls: id }));
}

/** 出どころ別の件数 → 上位 limit 件の行。残りは「ほか」にまとめる。 */
export function sourceRows(sources, limit = 5) {
  const list = (sources ?? []).filter((s) => s && Number(s.count) > 0).map((s) => ({ label: String(s.platform), value: Number(s.count) }));
  if (list.length <= limit) return list;
  const top = list.slice(0, limit - 1);
  const rest = list.slice(limit - 1).reduce((n, r) => n + r.value, 0);
  return [...top, { label: "ほか", value: rest }];
}

/** 日別の件数(週次 episode の daily)→ 折れ線の行。dayLabel は、日付の表示用の関数。 */
export function trendRows(daily, dayLabel) {
  return (daily ?? []).map((r) => ({ label: dayLabel(r.date), value: Number(r.total) || 0 }));
}

/** 図にする意味があるか(全部 0、または1行以下なら描かない)。 */
export const hasFigureData = (rows, min = 1) => (rows?.length ?? 0) >= min && rows.some((r) => r.value > 0);

/** "2026-10-21" → "10/21"(図の軸の表示用)。 */
export function dayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(date ?? "");
}
