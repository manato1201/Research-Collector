// 認証まわりの純粋な関数(Web Crypto のみ使用。Workers と Node の両方で動く = node でテストできる)
//
// 2種類の認証:
//   1. Bearer トークン(INGEST_TOKEN): GitHub Actions など「機械」から。取り込み・読み出し・ボード。
//   2. セッション Cookie(VIEW_PASSWORD でログイン): ブラウザの「人」から。読み出し・ボード。
//
// Cloudflare Access を使わない(無料プランで追加の設定なしに動く)ための、最小のログインの仕組み。
// Access で保護できる場合は、そちらを重ねてよい(wrangler.jsonc の READ_REQUIRES_TOKEN の注記を参照)。

export const SESSION_COOKIE = "rb_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

const enc = new TextEncoder();

/** 長さに依らず一定時間で比較する(両方を SHA-256 にしてから比較)。 */
export async function timingSafeEqualStrings(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(ha, hb); // Workers
  }
  // Node など: 固定長(32バイト)のダイジェスト同士を、全バイトを見る比較にする
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const toBase64Url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64Url = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

// セッションの署名鍵は VIEW_PASSWORD から導く。パスワードを変えると、既存のセッションは全て無効になる。
async function sessionKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(`research-broadcast/session/v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `<有効期限(秒)>.<署名>` を返す。 */
export async function signSession(
  secret,
  nowSec = Math.floor(Date.now() / 1000),
  ttl = SESSION_TTL_SECONDS,
) {
  const exp = String(nowSec + ttl);
  const sig = await crypto.subtle.sign(
    "HMAC",
    await sessionKey(secret),
    enc.encode(exp),
  );
  return `${exp}.${toBase64Url(sig)}`;
}

/** 署名が正しく、期限内なら true。署名の検証は crypto.subtle.verify(定数時間)。 */
export async function verifySession(
  secret,
  value,
  nowSec = Math.floor(Date.now() / 1000),
) {
  if (!secret || typeof value !== "string") return false;
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const exp = value.slice(0, dot);
  if (!/^\d{9,12}$/.test(exp) || Number(exp) <= nowSec) return false;
  let sig;
  try {
    sig = fromBase64Url(value.slice(dot + 1));
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await sessionKey(secret),
    sig,
    enc.encode(exp),
  );
}

export function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookieHeader(value, maxAge, secure = true) {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Origin が、このリクエストの宛先と同じホストか。Cookie 認証の書き込みに使う(CSRF 対策)。 */
export function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ Cloudflare Access(複数人で使うときのログイン)
//
// Access をこのサイトの前に置くと、通過したリクエストに `Cf-Access-Jwt-Assertion`(署名つきの JWT)が付く。
// ここではその JWT を検証し、メールアドレスで「誰か」を決める。守っていること:
//   - 署名(RS256 だけ。none / HS256 は受け付けない)・発行者(iss)・宛先(aud)・期限(exp / nbf)を必ず検証する。
//     ヘッダーを偽装しても、Cloudflare の秘密鍵が無ければ通らない。
//   - 公開鍵は https://<チーム>.cloudflareaccess.com/cdn-cgi/access/certs(JWKS)から取る(取得は index.js 側)。
//   - 失敗の理由は返さない(null)。

const decodeJsonSegment = (segment) => JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));

/** "https://x.cloudflareaccess.com/" → "x.cloudflareaccess.com" */
export function normalizeTeamDomain(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/** 許可するメールアドレスの一覧(カンマ区切り・小文字)。 */
export function parseEmailList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Access の JWT を検証して、claims を返す。1 つでも合わなければ null(例外は投げない)。
 * jwks = { keys: [{ kid, kty: "RSA", n, e }, ...] }
 */
export async function verifyAccessJwt(token, { teamDomain, aud, jwks, nowSec = Math.floor(Date.now() / 1000), leeway = 30 }) {
  try {
    if (typeof token !== "string" || !teamDomain || !aud) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decodeJsonSegment(parts[0]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const jwk = jwks?.keys?.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      fromBase64Url(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const claims = decodeJsonSegment(parts[1]);
    if (claims.iss !== `https://${teamDomain}`) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud)) return null;
    if (typeof claims.exp !== "number" || claims.exp + leeway <= nowSec) return null;
    if (typeof claims.nbf === "number" && claims.nbf - leeway > nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}
