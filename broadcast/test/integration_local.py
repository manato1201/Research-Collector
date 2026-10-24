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
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

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
from datetime import datetime, timedelta, timezone
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
# 一覧の先頭200件に入るとは限らない(実データが増えるため)ので、検索で直接引く
x = [a for a in call("GET", "/api/search?q=" + urllib.parse.quote("X投稿"))[1]["articles"] if a["source_type"] == "x_post"]
check("x_post stored without summary", x and x[0]["summary"] is None, x)
w = [a for a in call("GET", "/api/search?q=" + urllib.parse.quote("要約つき"))[1]["articles"] if a["url_hash"] == "aaaaaaaaaaaaaaaa"]
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
base_counts = {k: v for k, v in total["by_category"].items() if k in by_cat}  # 追加カテゴリ(あれば)は別に見る
check("status by_category matches /api/articles?category=", base_counts == {k: v for k, v in by_cat.items() if v}, (total["by_category"], by_cat))
check("category lane contains only that category",
      all("graphics_research" in a["categories"] for a in call("GET", "/api/articles?category=graphics_research&limit=200")[1]["articles"]))
check("bad category -> 400", call("GET", "/api/articles?category=unknown_category")[0] == 400)
check("injection-like input -> 400", call("GET", "/api/articles?category=%27%20OR%201%3D1%20--")[0] == 400)
st = call("GET", "/api/status")[1]
check("last_ingest records the latest attempt (the all-rejected one)", st["last_ingest"]["accepted"] == 0 and st["last_ingest"]["rejected"] == 1, st["last_ingest"])
check("last_success_at is kept (not overwritten by the rejection)", bool(st["last_success_at"]), st)

# --- 保持期間(RETENTION_DAYS)を過ぎた記事は、取り込みのたびに消える
OLD = "eeeeeeeeeeeeeee1"
old_at = (datetime.now(timezone.utc) - timedelta(days=400)).strftime("%Y-%m-%dT%H:%M:%SZ")
s, r = call("POST", "/api/ingest", {"schema": 1, "articles": [
    {"url_hash": OLD, "url": "https://example.com/old", "title": "古い記事", "source_type": "blog", "platform": "zenn",
     "categories": ["game_dev_tech"], "status": "added", "collected_at": old_at, "summary": "あ" * 60}]})
check("an article past the retention period is accepted, then purged by the same ingest",
      s == 200 and r["accepted"] == 1 and call("GET", "/api/status")[1]["last_ingest"]["purged"] >= 1
      and not [a for a in call("GET", "/api/search?q=%E5%8F%A4%E3%81%84%E8%A8%98%E4%BA%8B")[1]["articles"] if a["url_hash"] == OLD], (s, r))

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

# --- レポート(週次ダイジェスト)・ウォッチ・収集元別件数(scripts/post_report.py の実クライアントで送る)
import tempfile
import post_report as pr
from nbklm import digest as digest_mod

parts = {
    "year": "2026", "week": "W41", "date": "2026-10-11",
    "generated_label": "2026年10月11日 21:08", "generated_at": "2026-10-11T21:08:01Z",
    "notebooks": ["Game-Dev-Tech-2026-W41", "Software-Engineering-2026-W41"],
    "sections": [
        {"category": "game_dev_tech", "label": digest_mod.CATEGORY_LABELS["game_dev_tech"],
         "body": "## 要点\n- **Unity** の更新([公式](https://unity.com/))\n\n本文"},
        {"category": "software_engineering", "label": digest_mod.CATEGORY_LABELS["software_engineering"],
         "body": "### 論文\n- 一覧\n\n<img src=x onerror=alert(1)>\n\n[危険](javascript:alert(1)) <script>alert(2)</script>"},
        # ローカル限定の分野に当たる、許可外のカテゴリ。クライアントが送らず、受け口も拒否する
        {"category": "some_local_only_category", "label": "## local", "body": "ローカル限定の内容"},
    ],
}
with tempfile.TemporaryDirectory() as d:
    md_path = os.path.join(d, "weekly_digest_2026-10-11.md")
    open(md_path, "w", encoding="utf-8").write("# Weekly Research Digest — 2026-10-11\n\n" + digest_mod.render_digest_markdown(parts))
    json.dump(parts, open(os.path.join(d, "weekly_digest_2026-10-11.json"), "w", encoding="utf-8"), ensure_ascii=False)
    report = pr.load_report(md_path)

check("client builds the report from structured parts", report and report["id"] == "digest:2026-10-11" and len(report["sections"]) == 2, report)
check("client drops the non-allowlisted section", "some_local_only_category" not in json.dumps(report), report)
s, r = call("POST", "/api/ingest", {"schema": 1, "reports": [report]})
check("report ingested", s == 200 and r["reports"] == 1, (s, r))
s, r = call("GET", "/api/reports")
check("report list returns the report with section count", s == 200 and r["reports"] and r["reports"][0]["id"] == "digest:2026-10-11" and r["reports"][0]["sections"] == 2, (s, r))
s, r = call("GET", "/api/reports/digest%3A2026-10-11")
check("report body returned (week, sections, markdown)", s == 200 and r["week"] == "2026-W41" and r["sections"][0]["category"] == "game_dev_tech" and "Unity" in r["sections"][0]["markdown"], (s, str(r)[:200]))
check("unknown report -> 404", call("GET", "/api/reports/digest%3A1999-01-01")[0] == 404)
check("reports require auth", call("GET", "/api/reports", token=None)[0] == 401)
s, r = call("POST", "/api/ingest", {"schema": 1, "reports": [report, report]})
check("re-sending the report is idempotent", s == 200 and len(call("GET", "/api/reports")[1]["reports"]) == 1)
bad = json.loads(json.dumps(report))
bad["sections"].append({"category": "some_local_only_category", "heading": "x", "markdown": "y"})
s, r = call("POST", "/api/ingest", {"schema": 1, "reports": [bad]})
check("Worker rejects a report with a non-allowlisted category (422)", s == 422 and r["errors"][0]["error"] == "category_not_allowed", (s, r))

watch = [{"watch": "skills.sh", "title": "owner/repo · skill", "url": "https://skills.sh/owner/repo/skill", "detected_at": now}]
s, r = call("POST", "/api/ingest", {"schema": 1, "watch": watch, "run": {"by_source": {"Zenn/Qiita": 48, "X posts": 0}}})
check("watch-only ingest accepted", s == 200 and r["watch"] == 1, (s, r))
st_watch = call("GET", "/api/status")[1]  # 後の失敗する取り込みで last_ingest が上書きされる前に読む
s, r = call("GET", "/api/watch")
check("watch items listed", s == 200 and r["items"] and r["items"][0]["url"] == "https://skills.sh/owner/repo/skill", (s, r))
s, r = call("POST", "/api/ingest", {"schema": 1, "watch": [{**watch[0], "url": "javascript:alert(1)"}]})
check("watch with a non-http url -> 422", s == 422, (s, r))
check("status reports counts for reports and watch", st_watch["reports"]["total"] == 1 and st_watch["watch"]["total"] == 1, (st_watch["reports"], st_watch["watch"]))
check("by_source is kept in last_run", st_watch["last_run"]["by_source"] == {"Zenn/Qiita": 48, "X posts": 0}, st_watch["last_run"])
check("last_run survives later ingests without a run (e.g. report-only)",
      call("GET", "/api/status")[1]["last_run"]["by_source"] == {"Zenn/Qiita": 48, "X posts": 0})
check("articles can be filtered by until", call("GET", "/api/articles?since=2026-01-01&until=2026-01-31")[1]["total"] == 0)
check("bad until -> 400", call("GET", "/api/articles?until=soon")[0] == 400)
check("merged articles are listable (status=merged)", call("GET", "/api/articles?status=merged&limit=5")[0] == 200)

# --- 追加カテゴリ(Worker の環境変数 EXTRA_CATEGORIES。未設定の環境では SKIP)
s, cats = call("GET", "/api/categories")
check("categories endpoint lists the base three", s == 200 and cats["base"] == ["game_dev_tech", "graphics_research", "software_engineering"], (s, cats))
if cats.get("extra"):
    ex = cats["extra"][0]["id"]
    ex_art = {"url_hash": "eeeeeeeeeeeeee01", "url": "https://example.com/extra-1", "title": "追加カテゴリの記事",
              "source_type": "extra", "platform": "arxiv", "categories": [ex], "status": "added",
              "collected_at": now, "published": "2020-01-01"}
    s, r = call("POST", "/api/ingest", {"schema": 1, "articles": [ex_art]})
    check("article in a configured extra category is accepted", s == 200 and r["accepted"] == 1, (s, r))
    s, r = call("GET", f"/api/articles?category={ex}&status=added")
    check("extra category is filterable", s == 200 and r["total"] == 1 and r["articles"][0]["url_hash"] == "eeeeeeeeeeeeee01", (s, r))
    # collected_at は最初に収集した時刻を保つ(再実行で変わらない)ため、保存されている値の日付で確かめる
    first_day = call("GET", f"/api/articles?category={ex}&status=added")[1]["articles"][0]["collected_at"][:10]
    s, r = call("GET", f"/api/articles?category={ex}&collected_since={first_day}")
    check("collected_since finds a paper with an old publication date", r["total"] == 1, r)
    s, r = call("GET", f"/api/articles?category={ex}&since={now[:10]}")
    check("since (publication date) does not", r["total"] == 0, r)
    check("an unconfigured category is still rejected",
          call("POST", "/api/ingest", {"schema": 1, "articles": [{**ex_art, "url_hash": "eeeeeeeeeeeeee02", "categories": ["not_configured"]}]})[0] == 422)
    st = call("GET", "/api/status")[1]
    check("status by_category includes the extra category", st["articles"]["by_category"].get(ex) == 1, st["articles"]["by_category"])
    check("extra episodes use the configured id",
          call("POST", "/api/ingest", {"schema": 1, "episodes": [{"id": f"daily:{now[:10]}:{ex}", "kind": "daily", "date": now[:10], "category": ex, "headline": "h", "data": {}}]})[0] == 200)
else:
    print("SKIP extra category checks (EXTRA_CATEGORIES not configured)")

# --- 検索(FTS5 trigram / LIKE)・設定・ウォッチワード・まとめて既読・書き出し
srch = {"url_hash": "5ea0000000000001", "url": "https://example.com/search-1", "title": "Zebracorn レンダリング最適化の検索テスト",
        "source_type": "unity", "platform": "search_test_src", "categories": ["graphics_research"], "status": "added",
        "collected_at": now, "published": "2026-10-10", "summary": "検索用の要約です。"}
s, r = call("POST", "/api/ingest", {"schema": 1, "articles": [srch]})
check("search fixture ingested", s == 200 and r["accepted"] == 1, (s, r))
s, r = call("GET", "/api/search?q=Zebracorn")
check("full-text search finds a word (3+ chars)", s == 200 and r["mode"] == "fts" and [a["url_hash"] for a in r["articles"]] == ["5ea0000000000001"], (s, r))
s, r = call("GET", "/api/search?q=" + urllib.parse.quote("レンダリング"))
check("full-text search finds Japanese by substring", s == 200 and any(a["url_hash"] == "5ea0000000000001" for a in r["articles"]), (s, str(r)[:200]))
s, r = call("GET", "/api/search?q=" + urllib.parse.quote("検索"))
check("short (2 char) queries fall back to LIKE", s == 200 and r["mode"] == "like" and any(a["url_hash"] == "5ea0000000000001" for a in r["articles"]), (s, str(r)[:200]))
s, r = call("GET", "/api/search?q=" + urllib.parse.quote("Zebracorn 存在しない語"))
check("multiple words are ANDed", s == 200 and r["articles"] == [], (s, r))
check("search handles quotes and operators as plain text", call("GET", "/api/search?q=" + urllib.parse.quote('" OR 1=1 --'))[0] == 200)
check("empty query -> 400", call("GET", "/api/search?q=")[0] == 400)
check("search requires auth", call("GET", "/api/search?q=abc", token=None)[0] == 401)
# 更新(upsert)しても索引が壊れず、1件のまま
call("POST", "/api/ingest", {"schema": 1, "articles": [{**srch, "title": "Zebracorn レンダリング最適化の検索テスト(更新)"}]})
s, r = call("GET", "/api/search?q=Zebracorn")
check("an updated article stays searchable exactly once", len(r["articles"]) == 1 and "更新" in r["articles"][0]["title"], r)

s, r = call("PUT", "/api/prefs/watchwords", {"value": ["Zebracorn", "存在しない語です"]})
check("watchwords saved", s == 200 and r["value"] == ["Zebracorn", "存在しない語です"], (s, r))
s, r = call("GET", "/api/watchwords")
by_word = {i["word"]: i for i in r.get("items", [])}
check("watchword summary has the count and latest titles",
      s == 200 and by_word["Zebracorn"]["count"] == 1 and by_word["Zebracorn"]["latest"][0]["url_hash"] == "5ea0000000000001"
      and by_word["存在しない語です"]["count"] == 0, (s, r))
check("prefs are readable", call("GET", "/api/prefs")[1]["watchwords"] == ["Zebracorn", "存在しない語です"])
check("bad pref -> 400", call("PUT", "/api/prefs/watchwords", {"value": "x"})[0] == 400)
check("unknown pref key -> 404", call("PUT", "/api/prefs/whatever", {"value": []})[0] == 404)
call("PUT", "/api/prefs/watchwords", {"value": []})
s, r = call("PUT", "/api/prefs/projects", {"value": [{"name": "卒論", "keywords": ["RAG", "MCP"]}]})
check("projects saved", s == 200 and r["value"][0]["name"] == "卒論", (s, r))
call("PUT", "/api/prefs/projects", {"value": []})

s, r = call("GET", "/api/sources")
check("sources lists platforms with counts", s == 200 and any(x["platform"] == "search_test_src" and x["n"] == 1 for x in r["sources"]), (s, str(r)[:200]))
s, r = call("GET", "/api/articles?category=graphics_research&status=added&limit=200&exclude_platforms=search_test_src")
check("excluded platforms are filtered out of article lists", s == 200 and not any(a["platform"] == "search_test_src" for a in r["articles"]), s)

# まとめて既読: 読む/試す/保留 に入れた記事は上書きしない
H1, H2 = "5ea0000000000001", "aaaaaaaaaaaaaaaa"
call("PUT", f"/api/board/{H2}", {"state": "try"})
s, r = call("POST", "/api/board/bulk", {"hashes": [H1, H2], "state": "read"})
check("bulk read accepted", s == 200 and r["count"] == 2, (s, r))
items = {i["url_hash"]: i["state"] for i in call("GET", "/api/board")[1]["items"]}
check("bulk read marks new rows and keeps 'try'", items.get(H1) == "read" and items.get(H2) == "try", items)
s, r = call("POST", "/api/board/bulk", {"hashes": [H1, H2], "state": "unread"})
items = {i["url_hash"]: i["state"] for i in call("GET", "/api/board")[1]["items"]}
check("bulk unread clears rows", s == 200 and H1 not in items and H2 not in items, items)
check("bulk rejects bad hashes and oversize requests",
      call("POST", "/api/board/bulk", {"hashes": ["nope"], "state": "read"})[0] == 400
      and call("POST", "/api/board/bulk", {"hashes": [f"{i:016x}" for i in range(201)], "state": "read"})[0] == 400)
check("bulk requires auth", call("POST", "/api/board/bulk", {"hashes": [H1], "state": "read"}, token=None)[0] == 401)

# --- 出典の種別・言語の絞り込み(件数が全体と合う)
all_n = call("GET", "/api/articles?status=added&limit=1")[1]["total"]
kind_total = sum(call("GET", f"/api/articles?status=added&kind={k}&limit=1")[1]["total"] for k in ("official", "article", "talk", "paper", "x", "other"))
check("every article belongs to exactly one kind (counts add up)", kind_total == all_n and all_n > 0, (kind_total, all_n))
ja_n = call("GET", "/api/articles?status=added&lang=ja&limit=1")[1]["total"]
en_n = call("GET", "/api/articles?status=added&lang=en&limit=1")[1]["total"]
check("lang ja + en add up to all", ja_n + en_n == all_n, (ja_n, en_n, all_n))
kana = re.compile("[ぁ-ゟ゠-ヿ一-鿿]")
ja_titles = [a["title"] for a in call("GET", "/api/articles?status=added&lang=ja&limit=100")[1]["articles"]]
en_titles = [a["title"] for a in call("GET", "/api/articles?status=added&lang=en&limit=100")[1]["articles"]]
check("lang=ja returns only titles with Japanese; lang=en none", all(kana.search(t) for t in ja_titles) and not any(kana.search(t) for t in en_titles), (ja_titles[:2], en_titles[:2]))
check("bad kind / lang -> 400", call("GET", "/api/articles?kind=nope")[0] == 400 and call("GET", "/api/articles?lang=fr")[0] == 400)

# --- ボードの読み込み(既定では既存の状態を変えない)
IM1, IM2 = "a1a1a1a1a1a1a1a1", "b2b2b2b2b2b2b2b2"
def im_state(h):
    return next((i for i in call("GET", "/api/board")[1]["items"] if i["url_hash"] == h), None)
s, r = call("POST", "/api/board/import", {"items": [{"url_hash": IM1, "state": "try", "note": "n1"}]})
check("import adds a new item", s == 200 and r["added"] == 1 and r["existing"] == 0 and im_state(IM1)["state"] == "try", (s, r))
s, r = call("POST", "/api/board/import", {"items": [{"url_hash": IM1, "state": "hold", "note": "changed"}, {"url_hash": IM2, "state": "read"}]})
check("import never silently overwrites an existing item", s == 200 and r["added"] == 1 and r["existing"] == 1 and r["updated"] == 0
      and im_state(IM1)["state"] == "try" and im_state(IM1)["note"] == "n1" and im_state(IM2)["state"] == "read", (s, r))
s, r = call("POST", "/api/board/import", {"items": [{"url_hash": IM1, "state": "hold", "note": "changed"}], "overwrite": True})
check("import with overwrite updates the existing item", s == 200 and r["updated"] == 1 and im_state(IM1)["state"] == "hold" and im_state(IM1)["note"] == "changed", (s, r))
check("import rejects bad payloads (all or nothing)",
      call("POST", "/api/board/import", {"items": [{"url_hash": IM2, "state": "done"}]})[0] == 400
      and call("POST", "/api/board/import", {"items": [{"url_hash": "x", "state": "try"}]})[0] == 400
      and call("POST", "/api/board/import", {"items": []})[0] == 400
      and call("POST", "/api/board/import", {"items": [{"url_hash": f"{i:016x}", "state": "try"} for i in range(501)]})[0] == 400)
check("import requires auth", call("POST", "/api/board/import", {"items": [{"url_hash": IM1, "state": "try"}]}, token=None)[0] == 401)
call("DELETE", f"/api/board/{IM1}"); call("DELETE", f"/api/board/{IM2}")
check("import test rows cleaned up", im_state(IM1) is None and im_state(IM2) is None)


s, r = call("GET", "/api/export?table=articles&offset=0&limit=5")
check("export returns a page with a next offset", s == 200 and r["count"] == 5 and r["next"] == 5 and "url_hash" in r["rows"][0], (s, str(r)[:150]))
tot, off, pages = 0, 0, 0
while off is not None and pages < 200:
    r = call("GET", f"/api/export?table=articles&offset={off}&limit=200")[1]
    tot += r["count"]; off = r["next"]; pages += 1
check("export pages through every article", tot == call("GET", "/api/status")[1]["articles"]["total"] + call("GET", "/api/articles?status=merged&limit=1")[1]["total"] + call("GET", "/api/articles?status=failed&limit=1")[1]["total"], tot)
check("export rejects unknown tables", call("GET", "/api/export?table=sqlite_master")[0] == 400)
check("export is bearer-only", call("GET", "/api/export?table=articles", token=None)[0] == 401)

# --- 解説(これは何か / 何ができるか / どう応用できるか)
recent = [a["url_hash"] for a in call("GET", "/api/articles?status=added&limit=30")[1]["articles"]]
s, r = call("GET", "/api/insights?hashes=" + ",".join(recent[:20]))
check("insights are returned for known articles (AI or the source's standard text)",
      s == 200 and len(r["insights"]) >= 1 and all(v["source"] in ("ai", "rule") and v["what"] and v["use"] and v["apply"] for v in r["insights"].values()),
      (s, str(r)[:200]))
check("insights ignore malformed hashes", call("GET", "/api/insights?hashes=../../etc,zzzz")[1] == {"insights": {}})
check("enrich is bearer-only", call("POST", "/api/enrich", token=None)[0] == 401)
s, r = call("POST", "/api/enrich?limit=1")
if s == 503:
    print("SKIP enrich checks (AI binding not available)")
else:
    check("enrich reports what it did", s == 200 and all(k in r for k in ("processed", "ok", "unusable", "errors", "pending", "model")), (s, r))
    if s == 200 and r["ok"] >= 1:
        # 処理されたのは「新しい順」の1件。表示用の一覧に入っているとは限らないので、書き出しで確かめる
        rows = call("GET", "/api/export?table=insights&limit=200")[1]["rows"]
        check("an enriched article is stored as a v2 AI insight (Japanese headline fields present)",
              any(x["source"] == "ai" and x["ver"] == 2 and x["what"] and x["use"] and x["apply"] for x in rows), str(rows[:1])[:200])
    check("enrich reports a record of its decisions per mode (X18)", s == 200 and set(r["decisions"]) == {"full", "title", "skip"}, r)
    s3, r3 = call("POST", "/api/enrich?limit=1")
    check("enrich is repeatable (idempotent per article)", s3 == 200, (s3, r3))

# --- セキュリティの点検(X2): 乱暴な入力でも、500 にならず、データも漏れない
nasty = ['"', "'", "' OR 1=1 --", '" OR "1"="1', "*", "a*", "NEAR(a b)", "a:b", "-", "(", ")", "%", "_", "\\", "\x00",
         "<script>alert(1)</script>", "../../etc/passwd", "a" * 300, "日本語\u0000", "AND", "OR", "NOT"]
bad = []
for q in nasty:
    for path in ("/api/search?q=", "/api/articles?category=", "/api/articles?kind=", "/api/articles?lang=", "/api/articles?exclude_platforms=",
                 "/api/watchwords?x=", "/api/insights?hashes="):
        s_, r_ = call("GET", path + urllib.parse.quote(q))
        if s_ >= 500:
            bad.append((path, q[:20], s_))
check("hostile query strings never cause a server error (no 5xx)", not bad, bad[:3])
s_, r_ = call("GET", "/api/search?q=" + urllib.parse.quote("' OR 1=1 --"))
check("an injection-style search returns only matching rows, not everything", s_ in (200, 400) and (s_ == 400 or len(r_["articles"]) == 0), (s_, str(r_)[:100]))
s_, r_, hdr = call_raw("GET", "/api/health")
check("API responses carry X-Content-Type-Options: nosniff", (hdr.get("x-content-type-options") or hdr.get("X-Content-Type-Options")) == "nosniff", dict(hdr))

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
    # 試行回数の制限: 同じ IP(ここでは、偽の cf-connecting-ip)から失敗が続くと、合っているパスワードでも 429
    import random
    run_ip = f"198.18.{random.randint(1, 250)}.{random.randint(1, 250)}"  # 実行のたびに別の IP(前回の制限の記録が残っていても影響しない)
    fake = {"origin": BASE, "cf-connecting-ip": run_ip}
    codes = [call_raw("POST", "/api/login", {"password": "wrong-" + str(i)}, headers=fake)[0] for i in range(8)]
    s9, r9, h9 = call_raw("POST", "/api/login", {"password": VIEW_PASSWORD}, headers=fake)
    check("login: 8 failures from one IP -> then 429 even with the right password", codes == [401] * 8 and s9 == 429, (codes, s9))
    check("login: the lockout says when to retry", int(h9.get("Retry-After") or h9.get("retry-after") or 0) > 0, dict(h9))
    s10, _, _ = call_raw("POST", "/api/login", {"password": VIEW_PASSWORD}, headers={"origin": BASE, "cf-connecting-ip": "198.19.0.1"})
    check("login: another IP is not locked out", s10 == 200, s10)
    s11, _, _ = call_raw("POST", "/api/logout", None, headers={"origin": "https://evil.example"})
    check("logout from a foreign origin -> 403", s11 == 403, s11)
    jar = {"cookie": cookie.split(";")[0]}
    s, r, _ = call_raw("GET", "/api/session", headers=jar)
    check("session: authenticated via cookie", r.get("authenticated") is True and r.get("via") == "session", r)
    check("cookie can read /api/articles", call_raw("GET", "/api/articles?limit=1", headers=jar)[0] == 200)
    check("cookie cannot ingest (bearer only)", call_raw("POST", "/api/ingest", {"schema": 1, "articles": []}, headers=jar)[0] == 401)
    check("cookie cannot export (bearer only)", call_raw("GET", "/api/export?table=articles", headers=jar)[0] == 401)
    s, r, _ = call_raw("PUT", "/api/prefs/watchwords", {"value": ["x1y2z3"]}, headers={**jar, **origin})
    check("cookie + same origin can save prefs", s == 200, (s, r))
    s, r, _ = call_raw("PUT", "/api/prefs/watchwords", {"value": ["x1y2z3"]}, headers={**jar, "origin": "https://evil.example"})
    check("cookie + foreign origin cannot save prefs (CSRF)", s == 403, (s, r))
    call("PUT", "/api/prefs/watchwords", {"value": []})
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
