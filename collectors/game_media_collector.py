"""
ゲームメディア コレクター — ゲーム・ゲーム制作の情報

- 電ファミニコゲーマー https://news.denfaminicogamer.jp/ (RSS: /feed)  ゲームのニュース・読み物・開発者インタビュー
- ゲームメーカーズ     https://gamemakers.jp/                          ゲーム制作のニュース・アセットのセール・開発者向けの情報 (RSS: /feed/)

取得: 各サイトが公開している RSS だけを使う(robots.txt で許可されている。本文のページは取りに行かない)。
保存: 題名・URL・公開日・フィードの要約(抜粋。長ければ短く切る)だけ。**本文は保存も再掲載もしない**(原文は URL から)。

電ファミは、ゲーム以外の話題(映画など)も載せる。ここでは絞り込まず、ゲームに関係の無いものは、
分類の補助(nbklm/classifier.py)が「どれでもない」として「要確認」に回す。

共通シグネチャ collect(max_per_feed) -> list[dict](url/title/source_type/platform/published_at/url_hash/summary)。
"""

import logging
from datetime import datetime

from .release_notes_collector import _entries_to_articles, _parse_date  # 同じ形の記事 dict を作る
from .retry import fetch_feed, record_failure

logger = logging.getLogger(__name__)

# (feed_url, source_type, platform, 1回の収集で取る最大件数)
MEDIA_FEEDS = [
    ("https://news.denfaminicogamer.jp/feed", "denfami",    "denfaminicogamer", 5),
    ("https://gamemakers.jp/feed/",           "gamemakers", "gamemakers",       5),
]


def collect(max_per_feed: int = 5) -> list[dict]:
    """各メディアの新着を返す。1つの取得に失敗しても、ほかは続ける(失敗は health.json に記録される)。"""
    articles: list[dict] = []
    seen_hashes: set = set()
    for feed_url, source_type, platform, cap in MEDIA_FEEDS:
        try:
            feed = fetch_feed(feed_url)
            entries = feed.entries[: min(cap, max_per_feed)]
            articles.extend(_entries_to_articles(entries, source_type, platform, seen_hashes))
            logger.info(f"[{platform}] {len(entries)} entries")
        except Exception as e:
            logger.warning(f"[{platform}] fetch failed {feed_url}: {e}")
            record_failure(feed_url, e)
    logger.info(f"[game_media] total {len(articles)} articles")
    return articles


def collect_backfill(since: datetime, until: datetime, max_per_feed: int = 50) -> list[dict]:
    """フィードが現存する範囲内で since〜until のものだけ返す(他 collector の backfill と同じ制約)。"""
    articles: list[dict] = []
    seen_hashes: set = set()
    for feed_url, source_type, platform, _cap in MEDIA_FEEDS:
        try:
            feed = fetch_feed(feed_url)
            in_range = [
                e for e in feed.entries[:max_per_feed]
                if (d := _parse_date(e)) is not None and since <= d <= until
            ]
            articles.extend(_entries_to_articles(in_range, source_type, platform, seen_hashes))
        except Exception as e:
            logger.warning(f"[{platform} backfill] failed {feed_url}: {e}")
    return articles
