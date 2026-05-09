"""
収集済みURL管理モジュール
重複追加を防ぐためURLのハッシュをファイルで永続管理する。

保存先: seen_urls.txt（リポジトリルートに自動生成）
フォーマット: 1行1ハッシュ（sha256の先頭16文字）
"""

import hashlib
import logging
import os

logger = logging.getLogger(__name__)

SEEN_URLS_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "seen_urls.txt",
)


def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def load_seen() -> set[str]:
    """seen_urls.txt を読み込んでハッシュのセットを返す"""
    if not os.path.exists(SEEN_URLS_FILE):
        return set()
    with open(SEEN_URLS_FILE, "r", encoding="utf-8") as f:
        seen = {line.strip() for line in f if line.strip()}
    logger.info(f"[seen_urls] loaded {len(seen)} hashes")
    return seen


def save_seen(hashes: set[str]) -> None:
    """ハッシュのセットを seen_urls.txt に保存する"""
    with open(SEEN_URLS_FILE, "w", encoding="utf-8") as f:
        for h in sorted(hashes):
            f.write(h + "\n")
    logger.info(f"[seen_urls] saved {len(hashes)} hashes")


def filter_new_articles(articles: list[dict]) -> tuple[list[dict], set[str]]:
    """
    収集済みURLを除外して新規記事だけを返す。

    Returns
    -------
    (new_articles, updated_seen_set)
    """
    seen = load_seen()
    new_articles = []
    new_hashes = set()

    for article in articles:
        url = article.get("url", "")
        h = article.get("url_hash") or _url_hash(url)
        article["url_hash"] = h

        if h in seen:
            continue

        new_articles.append(article)
        new_hashes.add(h)

    skipped = len(articles) - len(new_articles)
    logger.info(f"[seen_urls] {len(new_articles)} new, {skipped} already seen")

    updated_seen = seen | new_hashes
    return new_articles, updated_seen
