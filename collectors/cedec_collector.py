"""
CEDEC コレクター
- CEDiL（CEDEC Digital Library）の新着セッション タイトル＋URL
- CEDEC YouTube チャンネルの新着動画
"""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional

import feedparser
import urllib.request
from html.parser import HTMLParser

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
#  設定
# ------------------------------------------------------------------ #

CEDIL_TOP_URL = "https://cedil.cesa.or.jp/"

# CEDEC YouTube チャンネル RSS
# チャンネルID: UCmHaPXvwn9_4pMNAV6ewgoA
CEDEC_YOUTUBE_RSS = (
    "https://www.youtube.com/feeds/videos.xml"
    "?channel_id=UCmHaPXvwn9_4pMNAV6ewgoA"
)


# ------------------------------------------------------------------ #
#  ユーティリティ
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


# ------------------------------------------------------------------ #
#  CEDiL スクレイパー
# ------------------------------------------------------------------ #

class _CEDiLParser(HTMLParser):
    """トップページから新着セッションのタイトルとURLを抽出する"""

    def __init__(self):
        super().__init__()
        self.sessions: list[dict] = []
        self._in_news = False

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            attrs_dict = dict(attrs)
            href = attrs_dict.get("href", "")
            if "/cedil_sessions/view/" in href:
                full_url = (
                    href if href.startswith("http")
                    else f"https://cedil.cesa.or.jp{href}"
                )
                self._current_url = full_url
                self._current_title = ""
                self._capturing = True
            else:
                self._capturing = False

    def handle_data(self, data):
        if getattr(self, "_capturing", False):
            self._current_title += data.strip()

    def handle_endtag(self, tag):
        if tag == "a" and getattr(self, "_capturing", False):
            if self._current_url and self._current_title:
                self.sessions.append({
                    "url":   self._current_url,
                    "title": self._current_title,
                })
            self._capturing = False


def collect_cedil(max_items: int = 30) -> list[dict]:
    """
    CEDiL トップページから新着セッションを収集する。
    ログイン不要・タイトルとURLのみ取得。
    """
    articles = []
    seen_hashes = set()

    try:
        req = urllib.request.Request(
            CEDIL_TOP_URL,
            headers={"User-Agent": "Mozilla/5.0 (research-collector bot)"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        parser = _CEDiLParser()
        parser.feed(html)
        sessions = parser.sessions[:max_items]
        logger.info(f"[CEDiL] {len(sessions)} sessions found")

        for s in sessions:
            h = _url_hash(s["url"])
            if h in seen_hashes:
                continue
            seen_hashes.add(h)

            articles.append({
                "url":          s["url"],
                "title":        s["title"],
                "source_type":  "cedec",
                "platform":     "cedil",
                "published_at": None,
                "url_hash":     h,
            })

    except Exception as e:
        logger.warning(f"[CEDiL] fetch failed: {e}")

    return articles


# ------------------------------------------------------------------ #
#  CEDEC YouTube RSS
# ------------------------------------------------------------------ #

def collect_cedec_youtube(max_items: int = 20) -> list[dict]:
    """
    CEDEC 公式 YouTube チャンネルの新着動画を RSS から収集する。
    """
    articles = []
    seen_hashes = set()

    try:
        feed = feedparser.parse(CEDEC_YOUTUBE_RSS)
        entries = feed.entries[:max_items]
        logger.info(f"[CEDEC YouTube] {len(entries)} videos found")

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
                "source_type":  "cedec",
                "platform":     "cedec_youtube",
                "published_at": _parse_date(entry),
                "url_hash":     h,
            })

    except Exception as e:
        logger.warning(f"[CEDEC YouTube] fetch failed: {e}")

    return articles


# ------------------------------------------------------------------ #
#  まとめて収集
# ------------------------------------------------------------------ #

def collect(max_cedil: int = 30, max_youtube: int = 20) -> list[dict]:
    """CEDiL + CEDEC YouTube をまとめて収集して返す"""
    articles = []

    articles.extend(collect_cedil(max_cedil))
    articles.extend(collect_cedec_youtube(max_youtube))

    logger.info(f"[CEDEC] total {len(articles)} items collected")
    return articles
