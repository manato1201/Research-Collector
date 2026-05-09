"""
Unity / Unreal Engine 公式ブログ・リリースノート コレクター
"""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional

import feedparser

logger = logging.getLogger(__name__)

UNITY_FEEDS = [
    ("https://blog.unity.com/feed",                          "unity",  "unity_blog"),
    ("https://unity.com/releases/lts-vs-tech-stream/feed",   "unity",  "unity_release"),
]

UNREAL_FEEDS = [
    ("https://www.unrealengine.com/en-US/rss",               "unreal", "ue_blog"),
    ("https://forums.unrealengine.com/latest.rss",           "unreal", "ue_forum"),
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
            feed = feedparser.parse(feed_url)
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
