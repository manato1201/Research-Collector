"""
Unity / Unreal Engine 公式ブログ・リリースノート コレクター
"""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional

from .retry import fetch_feed

logger = logging.getLogger(__name__)

UNITY_FEEDS = [
    ("https://blog.unity.com/feed",                          "unity",  "unity_blog"),
    ("https://unity.com/releases/lts-vs-tech-stream/feed",   "unity",  "unity_release"),
]

# UE Forum (forums.unrealengine.com/latest.rss) はBot弾きで失敗率が高いため除外済み(DOCUMENT.md参照)
UNREAL_FEEDS = [
    ("https://www.unrealengine.com/en-US/rss",               "unreal", "ue_blog"),
]

ALL_FEEDS = UNITY_FEEDS + UNREAL_FEEDS


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


def collect(max_per_feed: int = 10) -> list[dict]:
    articles = []
    seen_hashes = set()

    for feed_url, source_type, platform in ALL_FEEDS:
        try:
            feed = fetch_feed(feed_url)
            entries = feed.entries[:max_per_feed]
            logger.info(f"[{platform}] {len(entries)} entries")

            for entry in entries:
                url = entry.get("link", "")
                if not url:
                    continue
                h = _url_hash(url)
                if h in seen_hashes:
                    continue
                seen_hashes.add(h)

                articles.append({
                    "url":          url,
                    "title":        entry.get("title", ""),
                    "source_type":  source_type,
                    "platform":     platform,
                    "published_at": _parse_date(entry),
                    "url_hash":     h,
                })

        except Exception as e:
            logger.warning(f"[{platform}] failed {feed_url}: {e}")

    logger.info(f"[unity_ue] total {len(articles)} articles")
    return articles


def collect_backfill(
    since: datetime,
    until: datetime,
    max_per_feed: int = 50,
) -> list[dict]:
    """
    RSSフィードが現在保持している範囲内で、since〜untilに公開日が収まる記事だけを返す。

    【制約】zenn_qiita_collector.collect_backfillと同様、フィードが現存する
    最古分までが上限。過去に一度フィードから外れた記事は取得不能。
    """
    articles = []
    seen_hashes = set()

    for feed_url, source_type, platform in ALL_FEEDS:
        try:
            feed = fetch_feed(feed_url)
            entries = feed.entries[:max_per_feed]
            logger.info(
                f"[{platform} backfill] {len(entries)} entries (フィード保持範囲内のみ)"
            )

            for entry in entries:
                url = entry.get("link", "")
                if not url:
                    continue

                published_at = _parse_date(entry)
                if published_at is None:
                    continue
                if published_at < since or published_at > until:
                    continue

                h = _url_hash(url)
                if h in seen_hashes:
                    continue
                seen_hashes.add(h)

                articles.append({
                    "url":          url,
                    "title":        entry.get("title", ""),
                    "source_type":  source_type,
                    "platform":     platform,
                    "published_at": published_at,
                    "url_hash":     h,
                })

        except Exception as e:
            logger.warning(f"[{platform} backfill] failed {feed_url}: {e}")

    logger.info(
        f"[unity_ue backfill] total {len(articles)} articles "
        f"({since.date()} 〜 {until.date()}, フィード保持範囲内)"
    )
    return articles
