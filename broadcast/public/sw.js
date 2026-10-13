// Research Broadcast — Service Worker(ホーム画面に追加・オフラインで直近の内容を見る)
//
// 方針:
//  - 同じオリジンの GET だけを扱う。**書き込み(PUT / POST / DELETE)は触らない**(オフラインではボード等を変更できない)。
//  - すべて「ネットワーク優先」。つながっているときは常に最新で、切れているときだけ、最後に見た内容を出す。
//    (キャッシュ優先にすると、更新後に古い JS と新しい JS が混ざって動かなくなるため。)
//  - ページ遷移(SPA)は、オフラインのとき、保存済みの index.html を返す。
//  - ログアウトしたら、保存した API の応答(記事・ボード等)を消す(ページから "clear" を受け取る)。
//  - 保存するのは、この端末のブラウザの中だけ。

const CACHE = "rb-v1";
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/theme-init.js",
  "/favicon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "clear") {
    event.waitUntil(
      caches.open(CACHE).then(async (c) => {
        const reqs = await c.keys();
        await Promise.all(
          reqs
            .filter((r) => new URL(r.url).pathname.startsWith("/api/"))
            .map((r) => c.delete(r)),
        );
      }),
    );
  }
});

// 取り込み・ログイン・書き出しなど、保存してはいけない API
const NEVER_CACHE = [
  "/api/login",
  "/api/logout",
  "/api/ingest",
  "/api/export",
  "/api/session",
];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((p) => url.pathname === p)) return;

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        // 成功した応答だけ保存する(401 などは保存しない)
        if (res.ok && (res.type === "basic" || res.type === "default")) {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((c) => c.put(req, copy))
            .catch(() => {});
        }
        return res;
      } catch {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === "navigate") {
          const shell =
            (await caches.match("/index.html")) || (await caches.match("/"));
          if (shell) return shell;
        }
        return new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    })(),
  );
});
