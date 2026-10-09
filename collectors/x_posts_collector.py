"""
X(旧Twitter)投稿コレクター — IMPROVEMENT_PLAN_2026-10.md S4

**ユーザーが `x_urls.txt` に書いた投稿URLだけ**を取り込む(検索・タイムライン巡回・フォロー先の自動取得はしない)。
x.com は自動取得を拒否するため、サードパーティの中継サービス fxtwitter(api.fxtwitter.com)の
JSON を使う。この依存は不安定になりうる:

- 取得できない投稿は**静かに失敗**し(例外にせず、health.json の source_failures に記録するだけ)、
  seen_urls.txt に載せないので**次回の実行で自動的に再試行**される。
- 中継サービス自体が止まっても、他の収集元には影響しない。

NotebookLM には投稿のURLではなく**本文(要約代わりのそのままの全文)+ 出典URL**のテキストソースとして追加する
(`article["text"]` を nbklm/client.py が add_text で登録する)。LLM による要約は行わない。

x_urls.txt の書式: 1行1URL。`#` 以降はコメント、空行は無視。
"""

import hashlib
import json
import logging
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from .retry import record_failure, retry

logger = logging.getLogger(__name__)

X_URLS_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "x_urls.txt"
)

FXTWITTER_API = "https://api.fxtwitter.com/{user}/status/{id}"
MAX_PER_RUN = 20  # 1回の実行で取得する最大件数(中継サービスへの負荷抑制)

_STATUS_RE = re.compile(
    r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})/status/(\d+)",
    re.IGNORECASE,
)


def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def canonical_url(user: str, status_id: str) -> str:
    return f"https://x.com/{user}/status/{status_id}"


def parse_x_urls(text: str) -> list[tuple[str, str]]:
    """x_urls.txt の中身から (user, status_id) のリストを返す(重複・コメント・不正行は除く)。"""
    seen, out = set(), []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        m = _STATUS_RE.match(line)
        if not m:
            logger.warning(f"[x_posts] skipped (not a status URL): {line[:80]}")
            continue
        key = (m.group(1), m.group(2))
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


@retry(times=3, base_delay=2.0)
def _fetch_status(user: str, status_id: str) -> dict:
    req = urllib.request.Request(
        FXTWITTER_API.format(user=user, id=status_id),
        headers={"User-Agent": "research-collector/1.0 (user-specified URLs only)"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    tweet = data.get("tweet")
    # 存在しない/非公開の投稿は HTTP 200 のまま code=404 等で返ることがある
    if data.get("code") != 200 or not tweet or not tweet.get("text"):
        raise RuntimeError(f"fxtwitter: no usable tweet (code={data.get('code')})")
    return tweet


def _tweet_to_article(tweet: dict, url: str) -> dict:
    author = tweet.get("author") or {}
    name = author.get("name") or author.get("screen_name") or ""
    handle = author.get("screen_name") or ""
    body = (tweet.get("text") or "").strip()
    one_line = re.sub(r"\s+", " ", body)
    title = f"{name} (@{handle}): {one_line[:60]}{'…' if len(one_line) > 60 else ''}"

    published: Optional[datetime] = None
    ts = tweet.get("created_timestamp")
    if isinstance(ts, (int, float)):
        published = datetime.fromtimestamp(ts, tz=timezone.utc)

    return {
        "url":          url,
        "title":        title,
        "source_type":  "x_post",
        "platform":     "x",
        "published_at": published,
        "url_hash":     _url_hash(url),
        # NotebookLM へはテキストソースとして追加する(nbklm/client.py)
        "text":         f"{body}\n\n投稿者: {name} (@{handle})\n出典: {url}",
    }


def collect(skip_hashes: set | None = None, max_items: int = MAX_PER_RUN) -> list[dict]:
    """
    x_urls.txt の未取得URLを取得して返す。
    skip_hashes に収集済みURLのハッシュ(seen_urls.txt)を渡すと、取得済みの投稿は取りに行かない。
    """
    if not os.path.exists(X_URLS_FILE):
        logger.info("[x_posts] x_urls.txt not found, skipping")
        return []

    with open(X_URLS_FILE, "r", encoding="utf-8") as f:
        targets = parse_x_urls(f.read())

    skip_hashes = skip_hashes or set()
    articles: list[dict] = []
    for user, status_id in targets:
        url = canonical_url(user, status_id)
        if _url_hash(url) in skip_hashes:
            continue
        if len(articles) >= max_items:
            break
        try:
            tweet = _fetch_status(user, status_id)
            articles.append(_tweet_to_article(tweet, url))
        except Exception as e:
            # 静かに失敗: ログと health.json に残すだけ。seen に載せないので次回再試行される
            logger.warning(f"[x_posts] fetch failed (will retry next run) {url}: {e}")
            record_failure(f"x:{user}/{status_id}", e)
        time.sleep(1)  # 中継サービスへの配慮

    logger.info(f"[x_posts] {len(articles)} new posts from {len(targets)} listed URLs")
    return articles
