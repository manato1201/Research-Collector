// ラジオの「止めた位置」と「聞き終えた回」の記憶(この端末だけ。localStorage)。
//
// 外部資料 第6弾 Z66 g(聞きやすさ): 止めた位置を覚える・聞き終えた回に印を付ける。
// DOM に触れない(単体テストできる)。storage は { getItem, setItem }(localStorage と同じ形)。
// 使えない・壊れていても、何も起きない(読めなければ「記録なし」、書けなければ黙って捨てる)。
// 記録するのは、題名(例: 「2026-11-08 の放送」)と、章の番号・名前・時刻だけ。記事の内容は入れない。

const KEY_POS = "rb-radio-pos";
const KEY_HEARD = "rb-radio-heard";
export const MAX_POSITIONS = 30; // 位置を覚える回の数(古いものから捨てる)
export const MAX_HEARD = 90; // 聞き終えた回の数(古いものから捨てる)

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動く */
  }
}

/** 位置の一覧(配列。形が違う項目は捨てる)。題名をオブジェクトのキーにしない(__proto__ などの扱いを避ける)。 */
function positions(storage) {
  const list = readJson(storage, KEY_POS);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e) =>
      e && typeof e.title === "string" && Number.isInteger(e.c) && e.c >= 0,
  );
}

/** いま聞いている章を覚える(同じ回は上書き)。 */
export function savePosition(storage, title, { c, label }, now = Date.now()) {
  if (typeof title !== "string" || !title || !Number.isInteger(c) || c < 0)
    return;
  const rest = positions(storage).filter((e) => e.title !== title);
  rest.push({ title, c, label: String(label ?? "").slice(0, 60), at: now });
  rest.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  writeJson(storage, KEY_POS, rest.slice(0, MAX_POSITIONS));
}

/** 覚えている位置。章の数に収まらないとき(番組の中身が変わったとき)は、無いものとして扱う。 */
export function getPosition(storage, title, chapterCount) {
  const e = positions(storage).find((x) => x.title === title);
  if (!e || e.c >= chapterCount) return null;
  return {
    c: e.c,
    label: typeof e.label === "string" ? e.label : "",
    at: Number(e.at) || 0,
  };
}

export function clearPosition(storage, title) {
  const rest = positions(storage).filter((e) => e.title !== title);
  writeJson(storage, KEY_POS, rest);
}

/** 聞き終えた回を記録する(重複しない。古いものから捨てる)。 */
export function markHeard(storage, title) {
  if (typeof title !== "string" || !title) return;
  const list = heardList(storage).filter((t) => t !== title);
  list.push(title);
  writeJson(storage, KEY_HEARD, list.slice(-MAX_HEARD));
}

function heardList(storage) {
  const list = readJson(storage, KEY_HEARD);
  return Array.isArray(list) ? list.filter((t) => typeof t === "string") : [];
}

export const heardSet = (storage) => new Set(heardList(storage));
