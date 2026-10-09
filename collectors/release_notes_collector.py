"""
変更履歴・リリースノート・モデル公開ページ コレクター(IMPROVEMENT_PLAN_2026-10.md S3)

追跡したい領域の「更新情報」を拾う。
- SideFX(Houdini)の変更履歴    : バージョン系列ごとのRSS(/changelog/rss/<ver>/)。最新系列を自動選択
- Cloudflare 変更履歴             : https://developers.cloudflare.com/changelog/rss/index.xml
- Hugging Face ブログ(モデル公開) : https://huggingface.co/blog/feed.xml
(UE PCG は Zenn / Qiita の `pcg` タグとして zenn_qiita_collector.py 側に追加)

共通シグネチャ collect(max_per_feed) -> list[dict](url/title/source_type/platform/published_at/url_hash)。
"""

import hashlib
import logging
import re
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from .retry import fetch_feed, record_failure, retry

logger = logging.getLogger(__name__)

# (feed_url, source_type, platform, 1回の収集で取る最大件数)
STATIC_FEEDS = [
    ("https://developers.cloudflare.com/changelog/rss/index.xml", "cloudflare", "cloudflare_changelog", 5),
    ("https://huggingface.co/blog/feed.xml",                      "model",      "huggingface_blog",      3),
]

SIDEFX_CHANGELOG_PAGE = "https://www.sidefx.com/changelog/"
SIDEFX_FEED_TMPL = "https://www.sidefx.com/changelog/rss/{ver}/"
SIDEFX_MAX = 5

# SideFXの変更履歴は日次ビルドごとのバグ修正が大量に並ぶ。「機能追加・改善」だけを拾うため、
# タイトルが "<ビルド番号>: Fixed ..." の形のものは除外する(ノイズ対策)。
_SIDEFX_FIX_RE = re.compile(r"^\s*[\d.]+:\s*(fix|fixed|fixes|fixing)\b", re.IGNORECASE)

_UA = "Mozilla/5.0 (research-collector bot)"


def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def _parse_date(entry) -> Optional[datetime]:
    for attr in ("published_parsed", "updated_parsed"):
        val = getattr(entry, attr, None)
        if val:
            try:
                return datetime(*val[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    return None


@retry(times=3, base_delay=2.0)
def _fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def latest_sidefx_series(page_html: str) -> Optional[str]:
    """変更履歴ページから最新のバージョン系列(例: '22_0')を返す。"""
    vers = set(re.findall(r"/changelog/rss/(\d+_\d+)/", page_html))
    if not vers:
        return None
    return max(vers, key=lambda v: tuple(int(x) for x in v.split("_")))


def is_sidefx_fix_noise(title: str) -> bool:
    return bool(_SIDEFX_FIX_RE.match(title or ""))


def _entries_to_articles(entries, source_type, platform, seen_hashes, filter_fn=None):
    articles = []
    for entry in entries:
        url = entry.get("link", "")
        title = entry.get("title", "")
        if not url or (filter_fn and filter_fn(title)):
            continue
        h = _url_hash(url)
        if h in seen_hashes:
            continue
        seen_hashes.add(h)
        articles.append({
            "url":          url,
            "title":        title,
            "source_type":  source_type,
            "platform":     platform,
            "published_at": _parse_date(entry),
            "url_hash":     h,
        })
    return articles


def _collect_sidefx(max_items: int, seen_hashes: set) -> list[dict]:
    try:
        series = latest_sidefx_series(_fetch_text(SIDEFX_CHANGELOG_PAGE))
        if not series:
            raise RuntimeError("SideFX changelog: version series not found")
        feed = fetch_feed(SIDEFX_FEED_TMPL.format(ver=series))
    except Exception as e:
        logger.warning(f"[sidefx] failed: {e}")
        record_failure("sidefx:changelog", e)
        return []
    # ノイズ除外「後」にmax_itemsで切る(Fixedが続く日でも機能追加を拾えるように)
    items = _entries_to_articles(
        feed.entries, "houdini", "sidefx_changelog", seen_hashes, filter_fn=is_sidefx_fix_noise
    )[:max_items]
    logger.info(f"[sidefx {series}] {len(items)} entries (fix-only entries skipped)")
    return items


def collect(max_per_feed: int = 5) -> list[dict]:
    """全ソースから更新情報を収集して返す。max_per_feed は各フィードの上限(既定値より小さければそちらを優先)。"""
    articles: list[dict] = []
    seen_hashes: set = set()

    for feed_url, source_type, platform, cap in STATIC_FEEDS:
        try:
            feed = fetch_feed(feed_url)
            entries = feed.entries[: min(cap, max_per_feed)]
            articles.extend(_entries_to_articles(entries, source_type, platform, seen_hashes))
            logger.info(f"[{platform}] {len(entries)} entries")
        except Exception as e:
            logger.warning(f"[{platform}] fetch failed {feed_url}: {e}")
            record_failure(feed_url, e)

    articles.extend(_collect_sidefx(min(SIDEFX_MAX, max_per_feed), seen_hashes))
    logger.info(f"[release_notes] total {len(articles)} articles")
    return articles


def collect_backfill(since: datetime, until: datetime, max_per_feed: int = 50) -> list[dict]:
    """フィードが現存する範囲内で since〜until のものだけ返す(他collectorのbackfillと同じ制約)。"""
    articles: list[dict] = []
    seen_hashes: set = set()
    feeds = [(u, s, p) for u, s, p, _ in STATIC_FEEDS]
    try:
        series = latest_sidefx_series(_fetch_text(SIDEFX_CHANGELOG_PAGE))
        if series:
            feeds.append((SIDEFX_FEED_TMPL.format(ver=series), "houdini", "sidefx_changelog"))
    except Exception as e:
        logger.warning(f"[sidefx backfill] failed: {e}")

    for feed_url, source_type, platform in feeds:
        try:
            feed = fetch_feed(feed_url)
            in_range = [
                e for e in feed.entries[:max_per_feed]
                if (d := _parse_date(e)) is not None and since <= d <= until
            ]
            articles.extend(_entries_to_articles(
                in_range, source_type, platform, seen_hashes,
                filter_fn=is_sidefx_fix_noise if platform == "sidefx_changelog" else None,
            ))
        except Exception as e:
            logger.warning(f"[{platform} backfill] failed {feed_url}: {e}")
    return articles
