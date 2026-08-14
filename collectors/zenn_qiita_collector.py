"""
Zenn / Qiita RSS コレクター
対象タグ: unity, unrealengine, directx12, hlsl, gamedev
"""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional

from .retry import fetch_feed

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
#  RSS フィード定義
# ------------------------------------------------------------------ #

ZENN_FEEDS = [
    ("https://zenn.dev/topics/unity/feed",         "unity",   "zenn"),
    ("https://zenn.dev/topics/unrealengine/feed",  "unreal",  "zenn"),
    ("https://zenn.dev/topics/directx/feed",       "unity",   "zenn"),
    ("https://zenn.dev/topics/hlsl/feed",          "unity",   "zenn"),
    ("https://zenn.dev/topics/gamedev/feed",       "unity",   "zenn"),
    ("https://zenn.dev/topics/houdini/feed",       "unity",   "zenn"),
]

QIITA_FEEDS = [
    ("https://qiita.com/tags/unity/feed",          "unity",   "qiita"),
    ("https://qiita.com/tags/unrealengine/feed",   "unreal",  "qiita"),
    ("https://qiita.com/tags/directx12/feed",      "unity",   "qiita"),
    ("https://qiita.com/tags/hlsl/feed",           "unity",   "qiita"),
    ("https://qiita.com/tags/gamedev/feed",        "unity",   "qiita"),
]

ALL_FEEDS = ZENN_FEEDS + QIITA_FEEDS


# ------------------------------------------------------------------ #
#  収集
# ------------------------------------------------------------------ #

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


def collect(max_per_feed: int = 20) -> list[dict]:
    """
    全フィードから記事を収集して返す。

    Returns
    -------
    list[dict]  各要素:
        url, title, source_type, platform, published_at, url_hash
    """
    articles = []
    seen_hashes = set()

    for feed_url, source_type, platform in ALL_FEEDS:
        try:
            feed = fetch_feed(feed_url)
            entries = feed.entries[:max_per_feed]
            logger.info(f"[{platform}] {feed_url}: {len(entries)} entries")

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
            logger.warning(f"[{platform}] fetch failed {feed_url}: {e}")

    logger.info(f"[zenn_qiita] total {len(articles)} articles collected")
    return articles


def collect_backfill(
    since: datetime,
    until: datetime,
    max_per_feed: int = 50,
) -> list[dict]:
    """
    RSSフィードが現在保持している範囲内で、since〜untilに公開日が収まる記事だけを返す。

    【制約】RSSフィードは直近数十件しか保持しないため、真の意味での過去バックフィルは
    できない。「フィードが現存する最古分」までが実質的な上限であり、過去に一度
    フィードから外れた記事は原理上取得不能。max_per_feedを大きくしても
    フィードの保持件数以上は取得できない点に注意。
    """
    articles = []
    seen_hashes = set()

    for feed_url, source_type, platform in ALL_FEEDS:
        try:
            feed = fetch_feed(feed_url)
            entries = feed.entries[:max_per_feed]
            logger.info(
                f"[{platform} backfill] {feed_url}: {len(entries)} entries "
                f"(フィード保持範囲内のみ)"
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
            logger.warning(f"[{platform} backfill] fetch failed {feed_url}: {e}")

    logger.info(
        f"[zenn_qiita backfill] total {len(articles)} articles "
        f"({since.date()} 〜 {until.date()}, フィード保持範囲内)"
    )
    return articles
