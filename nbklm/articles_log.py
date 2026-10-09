"""
収集記事ログ(articles_log.json)

main.py の日次収集で扱った新規記事の記録。2つの用途を兼ねる。
  1. 意味での重複判定(semantic_dedup)の比較対象 — 直近に追加した記事のタイトル
  2. 収集結果ビュー(results.html)と入口ページ(index.html)の数値の入力

seen_urls.txt と同様に Git にコミットして永続化する(daily_collect.yml / weekly_digest.yml)。
1記事1行で書き出し、差分が読みやすいようにしている。

注意: ローカル限定の拡張収集(local_collect_extra.py)はこのログに書かない。
      ローカル限定の分野名・記事タイトルを Git 履歴に残さないための隔離方針による。
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

LOG_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "articles_log.json",
)

RETENTION_DAYS = 90
MAX_ENTRIES = 2000

# status の値
ADDED = "added"      # NotebookLM へ追加できた
FAILED = "failed"    # 追加を試みたが失敗した
MERGED = "merged"    # 意味で重複と判定し、代表記事に統合した


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def load() -> list[dict]:
    if not os.path.exists(LOG_FILE):
        return []
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = data.get("entries", [])
        return entries if isinstance(entries, list) else []
    except Exception as e:
        # 壊れていても収集は止めない(ログは補助情報)
        logger.warning(f"[articles_log] load failed, starting empty: {e}")
        return []


def _prune(entries: list[dict]) -> list[dict]:
    cutoff = _iso(_now() - timedelta(days=RETENTION_DAYS))
    kept = [e for e in entries if e.get("collected_at", "") >= cutoff]
    return kept[-MAX_ENTRIES:]


def save(entries: list[dict]) -> None:
    entries = _prune(entries)
    lines = [json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in entries]
    body = ",\n".join(f"  {ln}" for ln in lines)
    text = f'{{"updated_at":"{_iso(_now())}","entries":[\n{body}\n]}}\n' if lines else \
        f'{{"updated_at":"{_iso(_now())}","entries":[]}}\n'
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        f.write(text)
    logger.info(f"[articles_log] saved {len(entries)} entries")


def _date_str(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    return str(value)[:10]


def make_entry(
    article: dict,
    status: str,
    categories: list[str],
    classification: dict | None = None,
    merged_into: str | None = None,
) -> dict:
    """収集した記事1件を、ログ用の dict にする。"""
    cls = classification or {}
    entry = {
        "url_hash":     article.get("url_hash", ""),
        "url":          article.get("url", ""),
        "title":        article.get("title", ""),
        "source_type":  article.get("source_type", ""),
        "platform":     article.get("platform", ""),
        "categories":   categories,
        "label":        cls.get("label"),
        "keywords":     cls.get("keywords", []),
        "review":       bool(cls.get("label") == "none"),
        "status":       status,
        "published":    _date_str(article.get("published_at")),
        "collected_at": _iso(_now()),
    }
    if merged_into:
        entry["merged_into"] = merged_into
    return entry


def append(new_entries: list[dict]) -> list[dict]:
    """既存ログに追記して保存し、保存後の全エントリを返す。同じ url_hash は新しい記録で置き換える。"""
    entries = load()
    new_hashes = {e["url_hash"] for e in new_entries if e.get("url_hash")}
    entries = [e for e in entries if e.get("url_hash") not in new_hashes]
    entries.extend(new_entries)
    save(entries)
    return entries


def recent_added(days: int = 14) -> list[dict]:
    """意味での重複判定の比較対象。直近 days 日に追加できた記事。"""
    cutoff = _iso(_now() - timedelta(days=days))
    return [
        e for e in load()
        if e.get("status") == ADDED and e.get("collected_at", "") >= cutoff
    ]
