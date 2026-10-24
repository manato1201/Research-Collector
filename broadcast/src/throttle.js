// ログインの試行回数の制限(無料プランで使える範囲: D1 の meta テーブルに、IP ごとの失敗回数を残す)
//
// Worker 側で総当たりを遅くする手段は、待ち時間だけでは足りない(並列に試せる)。
// 同じ IP からの失敗が、窓(15分)の中で上限(8回)に達したら、その IP からのログインを窓が明けるまで断る。
// 純粋な関数だけ(node でテストできる)。IP は、生のままではなくハッシュにして残す。

export const LOGIN_MAX_FAILURES = 8;
export const LOGIN_WINDOW_SEC = 900;

/** meta のキー。IP のハッシュの先頭16桁(生の IP は残さない)。 */
export async function throttleKey(ip) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`research-broadcast/login/${ip}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `lf:${hex.slice(0, 16)}`;
}

/** record: { n: 失敗回数, t0: 窓の開始(秒) } | null。 */
export function throttleState(record, nowSec) {
  if (!record || !Number.isFinite(record.n) || !Number.isFinite(record.t0)) return { locked: false, retryAfter: 0 };
  const left = record.t0 + LOGIN_WINDOW_SEC - nowSec;
  return left > 0 && record.n >= LOGIN_MAX_FAILURES ? { locked: true, retryAfter: left } : { locked: false, retryAfter: 0 };
}

/** 失敗を1回数えた新しい record。窓が明けていたら、数え直す。 */
export function recordFailure(record, nowSec) {
  if (!record || !Number.isFinite(record.t0) || nowSec - record.t0 >= LOGIN_WINDOW_SEC) return { n: 1, t0: nowSec };
  return { n: (Number(record.n) || 0) + 1, t0: record.t0 };
}
