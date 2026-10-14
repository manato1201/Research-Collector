// 「今日のおすすめ」の選び方(規則ベース。DOM に依存せず、node でテストできる)
//
// 候補の中から1本を選ぶ。点数が同じなら、先に並んでいるもの(注目・新しい順)を選ぶので、結果は毎回同じ。
//  +6  ウォッチワードが、題名・要約に含まれる(語ごと)
//  +5  関連プロジェクトのキーワードが、題名・要約に含まれる(プロジェクトごと)
//  +3  AI の解説(根拠のある解説)がある
//  +2  要約がある(解説の根拠になる)
//  +1  注目に入っている
//  除外: 既読・非表示の収集元・「要確認」(分類に自信が無い)の記事

const includes = (hay, word) =>
  Boolean(word) && hay.includes(String(word).toLowerCase());

export function scoreCandidate(
  a,
  { watchwords = [], projects = [], insight = null, highlighted = false } = {},
) {
  const hay =
    `${a.title ?? ""} ${a.summary ?? ""} ${(a.keywords ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  const reasons = [];
  for (const w of watchwords) {
    if (includes(hay, w)) {
      score += 6;
      reasons.push({ kind: "watchword", name: w });
    }
  }
  for (const p of projects) {
    if ((p.keywords ?? []).some((k) => includes(hay, k))) {
      score += 5;
      reasons.push({ kind: "project", name: p.name });
    }
  }
  if (insight?.source === "ai") score += 3;
  if (String(a.summary ?? "").trim().length >= 40) score += 2;
  if (highlighted) score += 1;
  return { score, reasons };
}

/**
 * @param {Array} candidates  記事(url_hash・title・summary・platform …)。先頭ほど優先
 * @param {object} ctx        { watchwords, projects, insights: {hash: insight}, highlights: Set<hash>, isRead(hash), isMuted(platform) }
 * @returns {{article, score, reasons} | null}
 */
export function pickRecommendation(candidates, ctx = {}) {
  const {
    watchwords = [],
    projects = [],
    insights = {},
    highlights = new Set(),
    isRead = () => false,
    isMuted = () => false,
  } = ctx;
  let best = null;
  const seen = new Set();
  for (const a of candidates) {
    if (!a?.url_hash || seen.has(a.url_hash)) continue;
    seen.add(a.url_hash);
    if (a.review || isRead(a.url_hash) || isMuted(a.platform)) continue;
    const { score, reasons } = scoreCandidate(a, {
      watchwords,
      projects,
      insight: insights[a.url_hash] ?? null,
      highlighted: highlights.has(a.url_hash),
    });
    if (best === null || score > best.score)
      best = { article: a, score, reasons };
  }
  return best;
}
