"""
ResearchBroadcast Worker の結合テスト(ローカル)。実際の scripts/post_ingest.py のクライアントで、
実際の articles_log.json を、`wrangler dev --local` で動いている Worker へ送り、API を確認する。

    # 1つ目のターミナル(broadcast/ で)
    npx wrangler d1 migrations apply DB --local
    npx wrangler dev --local
    # 2つ目のターミナル(リポジトリのルートで)
    python broadcast/test/integration_local.py

トークンは broadcast/.dev.vars の INGEST_TOKEN(または環境変数 BROADCAST_INGEST_TOKEN)を使う。
注意: ローカルのD1に記事を書き込む(本番には触れない)。
"""
import json, os, re, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BASE = os.environ.get("BROADCAST_BASE_URL", "http://127.0.0.1:8787")


def _token():
    t = os.environ.get("BROADCAST_INGEST_TOKEN")
    if t:
        return t
    try:
        text = open(os.path.join(REPO, "broadcast", ".dev.vars"), encoding="utf-8").read()
        m = re.search(r"^INGEST_TOKEN=(.+)$", text, re.M)
        if m:
            return m.group(1).strip()
    except OSError:
        pass
    sys.exit("INGEST_TOKEN が見つかりません(broadcast/.dev.vars か BROADCAST_INGEST_TOKEN を設定してください)")


def _dev_var(name, default=None):
    v = os.environ.get(f"BROADCAST_{name}")
    if v:
        return v
    try:
        text = open(os.path.join(REPO, "broadcast", ".dev.vars"), encoding="utf-8").read()
        m = re.search(rf"^{name}=(.+)$", text, re.M)
        if m:
            return m.group(1).strip()
    except OSError:
        pass
    return default


TOKEN = _token()
VIEW_PASSWORD = _dev_var("VIEW_PASSWORD")
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + (f"   {detail}" if (detail and not cond) else ""))


def call(method, path, body=None, token=TOKEN, headers=None):
    h = {"content-type": "application/json"}
    if token:
        h["authorization"] = f"Bearer {token}"
    h.update(headers or {})
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def call_raw(method, path, body=None, headers=None):
    """ヘッダ(Set-Cookie など)も返す版。Bearer は付けない。"""
    h = {"content-type": "application/json"}
    h.update(headers or {})
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw), dict(e.headers)
        except Exception:
            return e.code, {"raw": raw}, dict(e.headers)


# --- 起動待ち
for _ in range(90):
    try:
        if call("GET", "/api/health", token=None)[0] == 200:
            break
    except Exception:
        pass
    time.sleep(1)
else:
    print("FAIL worker did not start"); sys.exit(1)

# --- 認証
check("health is open (no data)", call("GET", "/api/health", token=None) == (200, {"ok": True}))
check("ingest without token -> 401", call("POST", "/api/ingest", {"schema": 1, "articles": []}, token=None)[0] == 401)
check("ingest with wrong token -> 401", call("POST", "/api/ingest", {"schema": 1, "articles": []}, token="nope")[0] == 401)
check("reads require the token by default", call("GET", "/api/articles", token=None)[0] == 401)
check("GET /api/ingest -> 405", call("GET", "/api/ingest")[0] == 405)
check("unknown API path -> 404", call("GET", "/api/nope")[0] == 404)
with urllib.request.urlopen(BASE + "/some/spa/route", timeout=10) as _r:
    _html = _r.read().decode("utf-8")
    check("non-API path serves the SPA shell", _r.status == 200 and "Research Broadcast" in _html and "/app.js" in _html)
    check("static assets carry CSP header", "default-src 'self'" in (_r.headers.get("Content-Security-Policy") or ""), dict(_r.headers))
with urllib.request.urlopen(BASE + "/app.js", timeout=10) as _r:
    check("app.js is served as JavaScript", _r.status == 200 and "javascript" in (_r.headers.get("Content-Type") or ""), _r.headers.get("Content-Type"))

# --- 契約の検証
s, r = call("POST", "/api/ingest", {"schema": 99, "articles": [{}]})
check("unsupported schema -> 400", s == 400 and r.get("error") == "unsupported_schema", (s, r))
raw_req = urllib.request.Request(BASE + "/api/ingest", data=b"{not json", method="POST",
                                 headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
try:
    urllib.request.urlopen(raw_req, timeout=10); code = 200
except urllib.error.HTTPError as e:
    code = e.code
check("invalid JSON -> 400", code == 400)
big = {"schema": 1, "articles": [{"url_hash": "0" * 16, "url": "https://e.com/" + "x" * 1_100_000}]}
s, r = call("POST", "/api/ingest", big)
check("oversized body -> 413", s == 413, (s, r))

# --- 実クライアントで、実際の記事ログを送る
log = json.load(open(os.path.join(REPO, "articles_log.json"), encoding="utf-8"))["entries"]
# 取り込み対象の時間窓(36時間)に収まるよう、記録の収集時刻を現在に寄せた一時ログを使う
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
for e in log:
    e["collected_at"] = now
# 要約つきの行・X投稿・複数カテゴリ・ローカル限定カテゴリが混ざった行を足す
log += [
    {**log[0], "url_hash": "aaaaaaaaaaaaaaaa", "url": "https://example.com/with-summary", "title": "要約つきの記事",
     "summary": "SoCのメモリ階層を踏まえて帯域を減らす方法。", "summary_src": "feed"},
    {**log[0], "url_hash": "bbbbbbbbbbbbbbbb", "url": "https://x.com/u/status/1", "title": "X投稿",
     "source_type": "x_post", "platform": "x", "categories": ["software_engineering"],
     "summary": "本文を再掲載してはいけない", "summary_src": "feed"},
    {**log[0], "url_hash": "cccccccccccccccc", "url": "https://example.com/local-only", "title": "ローカル限定分野の記事",
     "categories": ["some_local_only_category"]},
]

# 実クライアント(post_ingest)の build_batches / post をそのまま使う
sys.path.insert(0, REPO)
from datetime import datetime, timezone
sys.path.insert(0, os.path.join(REPO, "scripts"))
import post_ingest as pi
health = json.load(open(os.path.join(REPO, "health.json"), encoding="utf-8"))
from nbklm import episodes as ep_mod
episodes = ep_mod.build_for_run(log, datetime.now(timezone.utc))
batches, stats = pi.build_batches(log, health, datetime.now(timezone.utc), 36, episodes=episodes)
check("client drops the local-only category before sending", stats["skipped_ineligible"] == 1, stats)
check("client strips x_post summary", all("summary" not in a for b in batches for a in b["articles"] if a["source_type"] == "x_post"))

total_accepted = 0
for b in batches:
    resp = pi.post(BASE + "/api/ingest", TOKEN, b)
    total_accepted += resp.get("accepted", 0)
check("real client payload accepted by the Worker", total_accepted == stats["articles"] and total_accepted > 0, (total_accepted, stats))

# --- 冪等: 同じものをもう一度送っても増えない
st1 = call("GET", "/api/status")[1]
for b in batches:
    pi.post(BASE + "/api/ingest", TOKEN, b)
st2 = call("GET", "/api/status")[1]
check("re-sending the same batch does not duplicate", st1["articles"]["total"] == st2["articles"]["total"], (st1, st2))

# --- ローカル限定カテゴリを直接送っても受け付けない(サーバー側の二重の保険)
s, r = call("POST", "/api/ingest", {"schema": 1, "articles": [
    {"url_hash": "dddddddddddddddd", "url": "https://example.com/l", "title": "t", "source_type": "x", "platform": "p",
     "categories": ["some_local_only_category"], "status": "added", "collected_at": now}]})
check("Worker rejects a non-allowlisted category (all rejected -> 422)", s == 422 and r["errors"][0]["error"] == "category_not_allowed", (s, r))

# --- 読み出し
s, r = call("GET", "/api/articles?limit=200&status=added")
arts = r["articles"]
check("articles returned with parsed fields", s == 200 and isinstance(arts[0]["categories"], list) and isinstance(arts[0]["review"], bool))
x = [a for a in arts if a["source_type"] == "x_post"]
check("x_post stored without summary", x and x[0]["summary"] is None, x)
w = [a for a in arts if a["url_hash"] == "aaaaaaaaaaaaaaaa"]
check("summary stored for normal articles", w and w[0]["summary"] and w[0]["summary_src"] == "feed", w)
check("local-only category article not stored", not [a for a in arts if a["url_hash"] == "cccccccccccccccc"])

# カテゴリ別: 複数カテゴリの記事は両方に出て、全体の件数(URL単位)では重複しない
total = call("GET", "/api/status")[1]["articles"]
by_cat = {c: call("GET", f"/api/articles?category={c}&status=added&limit=1")[1]["total"] for c in
          ("game_dev_tech", "graphics_research", "software_engineering")}
multi = [a for a in arts if len(a["categories"]) > 1]
check("multi-category articles exist in the data", len(multi) > 0)
check("sum of per-category counts exceeds URL total (multi-category appear in both lanes)",
      sum(by_cat.values()) > total["total"], (by_cat, total))
check("status by_category matches /api/articles?category=", total["by_category"] == {k: v for k, v in by_cat.items() if v}, (total["by_category"], by_cat))
check("category lane contains only that category",
      all("graphics_research" in a["categories"] for a in call("GET", "/api/articles?category=graphics_research&limit=200")[1]["articles"]))
check("bad category -> 400", call("GET", "/api/articles?category=unknown_category")[0] == 400)
check("injection-like input -> 400", call("GET", "/api/articles?category=%27%20OR%201%3D1%20--")[0] == 400)
st = call("GET", "/api/status")[1]
check("last_ingest records the latest attempt (the all-rejected one)", st["last_ingest"]["accepted"] == 0 and st["last_ingest"]["rejected"] == 1, st["last_ingest"])
check("last_success_at is kept (not overwritten by the rejection)", bool(st["last_success_at"]), st)

# --- episode(番組表)
ep_ids = sorted(e["id"] for e in episodes)
check("composer produced daily + weekly episodes", any(i.startswith("daily:") for i in ep_ids) and any(i.startswith("weekly:") for i in ep_ids), ep_ids)
s, r = call("GET", "/api/episodes?kind=daily&date=latest")
check("latest daily episodes returned", s == 200 and r["date"] and len(r["episodes"]) >= 2, (s, r.get("date")))
all_ep = [e for e in r["episodes"] if e["category"] is None]
check("daily 'all' episode has counts + highlights", all_ep and all_ep[0]["data"]["counts"]["total"] > 0 and all_ep[0]["data"]["highlights"], all_ep[:1])
lane = [e for e in r["episodes"] if e["category"] == "graphics_research"]
check("category episode carries other_categories badge data", lane and all("other_categories" in i for i in lane[0]["data"]["items"]))
check("x_post item has no summary in episode", not any(
    i.get("source_type") == "x_post" and "summary" in i for e in r["episodes"] for i in e["data"].get("items", []) + e["data"].get("highlights", [])))
s, r = call("GET", "/api/episodes?kind=weekly&date=latest")
check("weekly episode has 7 daily rows and 3 chapters", s == 200 and r["episodes"] and len(r["episodes"][0]["data"]["daily"]) == 7 and len(r["episodes"][0]["data"]["chapters"]) == 3, (s, r.get("date")))
check("bad episode kind -> 400", call("GET", "/api/episodes?kind=monthly")[0] == 400)
check("bad episode date -> 400", call("GET", "/api/episodes?date=yesterday")[0] == 400)
s, r = call("GET", "/api/episodes/dates?kind=daily")
check("episode dates listed", s == 200 and len(r["dates"]) >= 1, (s, r))
n_before = call("GET", "/api/episodes?kind=daily&date=latest")[1]["episodes"]
for b in batches:
    pi.post(BASE + "/api/ingest", TOKEN, b)
n_after = call("GET", "/api/episodes?kind=daily&date=latest")[1]["episodes"]
check("re-sending episodes is idempotent", len(n_before) == len(n_after) and [e["id"] for e in n_before] == [e["id"] for e in n_after])

# 許可外カテゴリの episode は受け付けない
s, r = call("POST", "/api/ingest", {"schema": 1, "articles": [], "episodes": [
    {"id": "daily:2026-10-11:unknown_category", "kind": "daily", "date": "2026-10-11", "category": "unknown_category", "headline": "x", "data": {}}]})
check("episode with a non-allowlisted category rejected (422)", s == 422, (s, r))

# --- 失敗した収集元(/status)
s, r = call("POST", "/api/ingest", {"schema": 1, "articles": [], "failures": [{"source": "テスト収集元", "error": "HTTP 503"}]})
check("failures-only ingest accepted", s == 200, (s, r))
st = call("GET", "/api/status")[1]
check("failures shown in /api/status", st["failures"] == [{"source": "テスト収集元", "error": "HTTP 503"}], st["failures"])
check("status reports latest episodes", st["episodes"]["latest_daily"] and st["episodes"]["latest_weekly"], st["episodes"])

# --- ボード(Bearer)
HASH = "aaaaaaaaaaaaaaaa"
s, r = call("PUT", f"/api/board/{HASH}", {"state": "try", "note": "あとで試す"})
check("board PUT with bearer", s == 200 and r["state"] == "try", (s, r))
s, r = call("GET", "/api/board")
item = [i for i in r["items"] if i["url_hash"] == HASH]
check("board lists the item joined with its article", item and item[0]["state"] == "try" and item[0]["article"]["title"] == "要約つきの記事", item)
check("board bad state -> 400", call("PUT", f"/api/board/{HASH}", {"state": "done"})[0] == 400)
check("board bad hash -> 400", call("PUT", "/api/board/not-a-hash", {"state": "try"})[0] == 400)
check("board note too long -> 400", call("PUT", f"/api/board/{HASH}", {"state": "try", "note": "x" * 201})[0] == 400)
check("board requires auth", call("GET", "/api/board", token=None)[0] == 401 and call("PUT", f"/api/board/{HASH}", {"state": "try"}, token=None)[0] == 401)
s, r = call("PUT", f"/api/board/{HASH}", {"state": "unread"})
check("board 'unread' clears the row", s == 200 and not [i for i in call("GET", "/api/board")[1]["items"] if i["url_hash"] == HASH])
call("PUT", f"/api/board/{HASH}", {"state": "hold"})
check("board DELETE", call("DELETE", f"/api/board/{HASH}")[0] == 200 and not [i for i in call("GET", "/api/board")[1]["items"] if i["url_hash"] == HASH])

# --- ログイン(人)・Cookie・CSRF
if VIEW_PASSWORD:
    s, r, _ = call_raw("GET", "/api/session")
    check("session: anonymous", s == 200 and r["authenticated"] is False and r["login_enabled"] is True, r)
    origin = {"origin": BASE}
    s, r, _ = call_raw("POST", "/api/login", {"password": "wrong"}, headers=origin)
    check("login with wrong password -> 401", s == 401 and r["error"] == "wrong_password", (s, r))
    s, r, _ = call_raw("POST", "/api/login", {"password": VIEW_PASSWORD}, headers={"origin": "https://evil.example"})
    check("login from a foreign origin -> 403", s == 403, (s, r))
    s, r, hdr = call_raw("POST", "/api/login", {"password": VIEW_PASSWORD}, headers=origin)
    cookie = hdr.get("Set-Cookie") or hdr.get("set-cookie") or ""
    check("login ok sets HttpOnly SameSite=Strict cookie", s == 200 and "rb_session=" in cookie and "HttpOnly" in cookie and "SameSite=Strict" in cookie, cookie[:80])
    jar = {"cookie": cookie.split(";")[0]}
    s, r, _ = call_raw("GET", "/api/session", headers=jar)
    check("session: authenticated via cookie", r.get("authenticated") is True and r.get("via") == "session", r)
    check("cookie can read /api/articles", call_raw("GET", "/api/articles?limit=1", headers=jar)[0] == 200)
    check("cookie cannot ingest (bearer only)", call_raw("POST", "/api/ingest", {"schema": 1, "articles": []}, headers=jar)[0] == 401)
    s, r, _ = call_raw("PUT", f"/api/board/{HASH}", {"state": "reading"}, headers={**jar, **origin})
    check("cookie + same origin can write board", s == 200, (s, r))
    s, r, _ = call_raw("PUT", f"/api/board/{HASH}", {"state": "reading"}, headers={**jar, "origin": "https://evil.example"})
    check("cookie + foreign origin cannot write board (CSRF)", s == 403, (s, r))
    s, r, _ = call_raw("PUT", f"/api/board/{HASH}", {"state": "reading"}, headers=jar)
    check("cookie without Origin cannot write board", s == 403, (s, r))
    tail = "aa" if not jar["cookie"].endswith("aa") else "bb"
    tampered = {"cookie": jar["cookie"][:-2] + tail}
    check("tampered cookie -> 401", call_raw("GET", "/api/articles?limit=1", headers=tampered)[0] == 401)
    call("DELETE", f"/api/board/{HASH}")
else:
    print("SKIP login checks (VIEW_PASSWORD not set)")

print("\nALL PASS" if all(results) else f"\n{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
