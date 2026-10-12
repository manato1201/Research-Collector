"""
収集した記事を ResearchBroadcast の Worker(`POST /api/ingest`)へ送る — ResearchBroadcast_DESIGN.md §4.1

GitHub Actions の収集が終わった後に実行する。**環境変数が未設定なら何もしない**(既存の収集は
これが無くても従来どおり動く)。送信に失敗しても収集結果には影響しない(ワークフロー側で
continue-on-error)。受け手側は `url_hash` で upsert する設計なので、同じ記事を再送しても重複しない(冪等)。

環境変数:
    BROADCAST_INGEST_URL     受け口のURL(例: https://<worker>/api/ingest)。未設定ならスキップ
    BROADCAST_INGEST_TOKEN   Bearer トークン(Actions のシークレット)
    CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
                             Cloudflare Access のサービス認証を使う場合の追加ヘッダ(任意)。
                             `/api/ingest` を Access とどう両立させるかは設計上「実装時に確定」のため、
                             両方に対応できるようにしてある

契約(schema 1): `broadcast/README.md` に、受け手側の仕様と一緒に書いてある。
articles に加えて、任意の episodes(日次・週次の番組表。nbklm/episodes.py が生成)・
failures(直近の実行で取得に失敗した収集元)・watch(配布サイトの新着。通知のみ)を、
最初のバッチに載せて送る。週次ダイジェスト(レポート)は scripts/post_report.py が送る。

    python scripts/post_ingest.py [--since-hours 36] [--dry-run]
"""

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

logger = logging.getLogger("post_ingest")

SCHEMA_VERSION = 1

# 受け手が受け付けるカテゴリ。ローカル限定の分野(notebook_ids_local.py)はここに無いので、
# 万が一ログに混ざっても送られない(隔離方針の二重の保険)。
ALLOWED_CATEGORIES = ("game_dev_tech", "graphics_research", "software_engineering")

BATCH_SIZE = 100

# 契約に含める項目(これ以外は送らない)
FIELDS = (
    "url_hash", "url", "title", "source_type", "platform", "categories", "label", "keywords",
    "review", "status", "published", "collected_at", "summary", "summary_src", "merged_into",
)


def _parse_iso(value: str):
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def eligible(entry: dict) -> bool:
    """送ってよい記事か。カテゴリが3つの範囲内・URLがhttp(s)・必須項目あり。"""
    cats = entry.get("categories") or []
    if not cats or any(c not in ALLOWED_CATEGORIES for c in cats):
        return False
    if not str(entry.get("url", "")).lower().startswith(("http://", "https://")):
        return False
    return bool(entry.get("url_hash") and entry.get("title"))


def shape(entry: dict) -> dict:
    """契約の項目だけを取り出す。X投稿は本文を再掲載しない方針なので要約を付けない。"""
    out = {k: entry[k] for k in FIELDS if k in entry and entry[k] is not None}
    if entry.get("source_type") == "x_post":
        out.pop("summary", None)
        out.pop("summary_src", None)
    return out


def build_failures(health: dict) -> list[dict]:
    """直近の実行で取得に失敗した収集元(/status の「失敗した収集元」に出す)。エラー文は短く切る。"""
    daily = (health or {}).get("daily", {}) or {}
    out = []
    for f in (daily.get("source_failures") or [])[:20]:
        if isinstance(f, dict) and f.get("source"):
            out.append({"source": str(f["source"])[:120], "error": str(f.get("error", ""))[:200]})
    return out


def build_watch(items: list[dict] | None) -> list[dict]:
    """配布サイトの新着(collectors/watch_collector の recent)。http(s) のものを最大50件。"""
    out = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        url = str(it.get("url", ""))
        if not url.lower().startswith(("http://", "https://")):
            continue
        if not (it.get("watch") and it.get("title") and it.get("detected_at")):
            continue
        out.append({
            "watch": str(it["watch"])[:40],
            "title": str(it["title"])[:200],
            "url": url[:2048],
            "detected_at": str(it["detected_at"]),
        })
    return out[:50]


def build_by_source(health: dict) -> dict:
    """health.json の by_source(収集元ごとの取得件数)。名前は短く・件数は整数だけを通す。"""
    raw = ((health or {}).get("daily", {}) or {}).get("by_source") or {}
    out = {}
    for name, n in list(raw.items())[:20]:
        if isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 100000:
            out[str(name)[:40]] = n
    return out


def build_batches(entries: list[dict], health: dict, now: datetime, since_hours: float = 36,
                  episodes: list[dict] | None = None, watch: list[dict] | None = None):
    """
    Returns
    -------
    (batches, stats)  batches は送信するJSON(dict)のリスト。stats は集計。
    episodes / failures は最初のバッチにだけ載せる(再送しても冪等)。
    """
    cutoff = now - timedelta(hours=since_hours)
    recent, skipped_ineligible = [], 0
    for e in entries:
        ts = _parse_iso(e.get("collected_at", ""))
        if ts is None or ts < cutoff:
            continue
        if not eligible(e):
            skipped_ineligible += 1
            continue
        recent.append(shape(e))

    daily = (health or {}).get("daily", {}) or {}
    run = {k: daily.get(k) for k in
           ("run_at", "collected", "new", "failed_sources", "unclassified", "merged", "notebooks_total")
           if daily.get(k) is not None}
    by_source = build_by_source(health)
    if by_source:
        run["by_source"] = by_source
    sent_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    batches = []
    for i in range(0, len(recent), BATCH_SIZE):
        batches.append({
            "schema": SCHEMA_VERSION,
            "sent_at": sent_at,
            "run": run,
            "articles": recent[i:i + BATCH_SIZE],
        })

    eps = [e for e in (episodes or []) if e.get("id")]
    failures = build_failures(health)
    watch_items = build_watch(watch)
    if (eps or failures or watch_items) and not batches:
        # 新しい記事が無くても、episode・失敗・ウォッチの状態は送る(受け口は articles が空でも受け付ける)
        batches.append({"schema": SCHEMA_VERSION, "sent_at": sent_at, "run": run, "articles": []})
    if batches:
        if eps:
            batches[0]["episodes"] = eps
        if watch_items:
            batches[0]["watch"] = watch_items
        batches[0]["failures"] = failures
    return batches, {
        "articles": len(recent), "skipped_ineligible": skipped_ineligible,
        "batches": len(batches), "episodes": len(eps), "failures": len(failures),
        "watch": len(watch_items),
    }


def allowed_url(url: str) -> bool:
    """https のみ許可する(Bearer トークンを平文で送らない)。ローカル検証用にループバックだけ http も可。"""
    from urllib.parse import urlparse
    u = urlparse(url)
    if u.scheme == "https" and u.hostname:
        return True
    return u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")


def _headers(token: str) -> dict:
    h = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {token}",
        "User-Agent": "research-collector/1.0 (ingest)",
    }
    cid, csec = os.environ.get("CF_ACCESS_CLIENT_ID"), os.environ.get("CF_ACCESS_CLIENT_SECRET")
    if cid and csec:
        h["CF-Access-Client-Id"] = cid
        h["CF-Access-Client-Secret"] = csec
    return h


def post(url: str, token: str, payload: dict, timeout: int = 30) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=_headers(token), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8", errors="replace")
        return json.loads(text) if text else {}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="記事を ResearchBroadcast の /api/ingest へ送る")
    ap.add_argument("--since-hours", type=float, default=36,
                    help="この時間内に収集した記事を送る(再送しても冪等。既定36時間 = 取りこぼし1回分を含む)")
    ap.add_argument("--dry-run", action="store_true", help="送らず、送る内容の集計だけ表示する")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    url = os.environ.get("BROADCAST_INGEST_URL", "").strip()
    token = os.environ.get("BROADCAST_INGEST_TOKEN", "").strip()
    if not args.dry_run and not (url and token):
        logger.info("BROADCAST_INGEST_URL / BROADCAST_INGEST_TOKEN not set — skipping (optional step)")
        return 0
    if url and not allowed_url(url):
        logger.error("BROADCAST_INGEST_URL must be https:// (the bearer token must not be sent in clear text)")
        return 1

    from nbklm import articles_log  # 遅延import(未設定時に余計な読み込みをしない)

    try:
        with open(os.path.join(ROOT, "health.json"), "r", encoding="utf-8") as f:
            health = json.load(f)
    except Exception:
        health = {}

    from nbklm import episodes as episodes_mod

    try:
        from collectors.watch_collector import recent as watch_recent
        watch_items = watch_recent(limit=50)
    except Exception as e:  # ウォッチは任意。取れなくても記事の送信は続ける
        logger.warning(f"watch items unavailable: {e}")
        watch_items = []

    now = datetime.now(timezone.utc)
    entries = articles_log.load()
    batches, stats = build_batches(
        entries, health, now, args.since_hours,
        episodes=episodes_mod.build_for_run(entries, now), watch=watch_items,
    )
    logger.info(
        f"ingest: {stats['articles']} articles, {stats['episodes']} episodes, {stats['watch']} watch items, "
        f"{stats['failures']} failures "
        f"in {stats['batches']} batch(es) ({stats['skipped_ineligible']} skipped as not eligible)"
    )
    if args.dry_run or not batches:
        return 0

    sent = 0
    for i, batch in enumerate(batches, 1):
        try:
            resp = post(url, token, batch)
            sent += len(batch["articles"])
            logger.info(f"batch {i}/{len(batches)} ok: {resp}")
        except urllib.error.HTTPError as e:
            logger.error(f"batch {i}/{len(batches)} failed: HTTP {e.code}")
            return 1
        except Exception as e:
            logger.error(f"batch {i}/{len(batches)} failed: {e}")
            return 1
    logger.info(f"ingest done: {sent} articles sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
