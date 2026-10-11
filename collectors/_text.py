"""
フィード由来のテキストの整形(タイトルのHTML除去・要約の短縮)

ResearchBroadcast_DESIGN.md §5「要約(enrich)段階0」: 収集時にフィードの summary / description を
**短く切って**保存する。要約は要点 + 出典(URL)のためのもので、本文の転載はしない。

- フィードによってはタイトルに生のHTMLタグが混ざる(例: UEブログの `<p><em>…`)。表示前に除去する。
- summary が無いフィード(Hugging Face ブログ等)は None を返す。要約は「あれば」の扱い。
- X の投稿は本文を再掲載しない方針(設計 §5)のため、x_posts_collector は summary を付けない。
"""

import html
import re
from typing import Optional

SUMMARY_MAX = 140  # 要約として保存する最大文字数(これを超えたら「…」で切る)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def strip_html(text: Optional[str]) -> str:
    """HTMLタグを除き、文字参照を戻し、空白を1つにまとめる。"""
    if not text:
        return ""
    no_tags = _TAG_RE.sub(" ", text)
    return _WS_RE.sub(" ", html.unescape(no_tags)).strip()


def clean_title(title: Optional[str]) -> str:
    return strip_html(title)


def make_summary(entry, max_len: int = SUMMARY_MAX) -> Optional[str]:
    """
    feedparser の entry から、短い要約を作る。無ければ None。
    タイトルと同じ文面(タイトルの言い換えにしかならないもの)は要約として意味が無いので None にする。
    """
    raw = None
    for key in ("summary", "description"):
        val = entry.get(key) if hasattr(entry, "get") else None
        if val:
            raw = val
            break
    text = strip_html(raw)
    if not text:
        return None
    title = strip_html(entry.get("title", "") if hasattr(entry, "get") else "")
    if title and (text == title or text.startswith(title) and len(text) - len(title) < 10):
        return None
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text
