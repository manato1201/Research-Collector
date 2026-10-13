"""
episode(番組表)の生成 — ResearchBroadcast_DESIGN.md §2・§4.2(工程 3: compose)

articles_log.json の記事から、サイトに出す「今日の放送」(日次)と「週次特集」を作る。

**無料プランで動かすための設計**: 設計書は Workflows(Cloudflare 上)での生成を想定していたが、Free プランでは
Worker の CPU 時間が 10ms に制限される。生成は GitHub Actions(無料)上の Python で行い、結果を
`scripts/post_ingest.py` が受け口へ送る。見出しは規則ベース(AI を使わない)なので、費用はかからない。

- 日次: その日(JST)に収集した記事。全体(all)とカテゴリ別3本。
- 週次: ISO週(JST の月〜日)。カテゴリ別の章・日別の推移・収集元別の件数(図はサイト側で描く)。
- id は `種別:日付:カテゴリ`。同じ入力から同じ episode ができるので、再送しても重複しない(冪等)。
- 件数0の episode は作らない(早朝の実行で「今日」が空の番組に上書きされないように)。
- ローカル限定の分野は articles_log に書かれないため、ここにも出ない。念のため3カテゴリ外は除く。
"""

import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from .semantic_dedup import _PLATFORM_RANK  # 公式 > 論文 > 個人記事(代表・注目の選び方を重複判定と揃える)

JST = timezone(timedelta(hours=9))

CATEGORIES = ("game_dev_tech", "graphics_research", "software_engineering")
CATEGORY_LABELS = {
    "game_dev_tech": "Game-Dev-Tech",
    "graphics_research": "Graphics-Research",
    "software_engineering": "Software-Engineering",
}

ITEM_LIMIT = 30      # カテゴリ別 episode の記事数の上限
HIGHLIGHTS = 5       # 全体 episode の注目の記事数
CHAPTER_ITEMS = 5    # 週次の章ごとの記事数
SUMMARY_MAX = 140


def _to_jst(iso_z: str) -> Optional[datetime]:
    try:
        return datetime.strptime(iso_z, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(JST)
    except Exception:
        return None


def _entry_date(entry: dict) -> Optional[str]:
    dt = _to_jst(entry.get("collected_at", ""))
    return dt.strftime("%Y-%m-%d") if dt else None


def _valid(entry: dict) -> bool:
    cats = entry.get("categories") or []
    return (
        entry.get("status") == "added"
        and bool(cats)
        and all(c in CATEGORIES for c in cats)
        and bool(entry.get("url_hash") and entry.get("url") and entry.get("title"))
    )


def _item(entry: dict, in_category: Optional[str] = None) -> dict:
    cats = [c for c in entry.get("categories", []) if c in CATEGORIES]
    item = {
        "url_hash": entry["url_hash"],
        "url": entry["url"],
        "title": entry["title"],
        "platform": entry.get("platform", ""),
        "source_type": entry.get("source_type", ""),
        "categories": cats,
        # 複数カテゴリの記事は両方のレーンに出す。「ほかのカテゴリにも」バッジ用(設計 §2.2)
        "other_categories": [c for c in cats if c != in_category] if in_category else [],
        "published": entry.get("published"),
        "review": bool(entry.get("review")),
    }
    summary = entry.get("summary")
    if summary and entry.get("source_type") != "x_post":  # Xの本文は再掲載しない(設計 §5)
        item["summary"] = str(summary)[:SUMMARY_MAX]
    kws = [k for k in (entry.get("keywords") or []) if not str(k).startswith("source:")]
    if kws:
        item["keywords"] = kws[:3]
    return item


def _order(entries: list[dict]) -> list[dict]:
    """新しい順 → 同じ新しさなら公式 > 論文 > 個人記事。"""
    by_date = sorted(
        entries,
        key=lambda e: (e.get("published") or (_entry_date(e) or ""), e.get("collected_at", "")),
        reverse=True,
    )
    return sorted(by_date, key=lambda e: _PLATFORM_RANK.get(e.get("platform", ""), 5))


def _uniq(entries: list[dict]) -> list[dict]:
    seen, out = set(), []
    for e in entries:
        if e["url_hash"] not in seen:
            seen.add(e["url_hash"])
            out.append(e)
    return out


def _counts(entries: list[dict]) -> dict:
    uniq = _uniq(entries)
    by_cat = {c: 0 for c in CATEGORIES}
    for e in uniq:
        for c in set(e["categories"]):
            if c in by_cat:
                by_cat[c] += 1
    return {
        "total": len(uniq),  # URL単位(複数カテゴリの記事を重複して数えない。設計 §2.2)
        "by_category": by_cat,
        "review": sum(1 for e in uniq if e.get("review")),
    }


def _short(title: str, n: int = 40) -> str:
    return title if len(title) <= n else title[: n - 1] + "…"


# ------------------------------------------------------------------ 日次

def build_daily(entries: list[dict], day: str) -> list[dict]:
    """
    day: 'YYYY-MM-DD'(JST)。
    Returns: episode のリスト。各要素は {id, kind, date, category, headline, data}。件数0なら空リスト。
    """
    todays = [e for e in entries if _valid(e) and _entry_date(e) == day]
    if not todays:
        return []

    ordered = _order(todays)
    counts = _counts(todays)
    all_headline = (
        f"新着{counts['total']}件 — " + " / ".join(
            f"{CATEGORY_LABELS[c]} {counts['by_category'][c]}" for c in CATEGORIES
        ) + f"。注目: {_short(ordered[0]['title'])}"
    )

    episodes = [{
        "id": f"daily:{day}:all",
        "kind": "daily", "date": day, "category": None,
        "headline": all_headline,
        "data": {
            "counts": counts,
            "highlights": [_item(e) for e in _uniq(ordered)[:HIGHLIGHTS]],
        },
    }]

    for cat in CATEGORIES:
        members = [e for e in ordered if cat in e["categories"]]
        if not members:
            continue
        episodes.append({
            "id": f"daily:{day}:{cat}",
            "kind": "daily", "date": day, "category": cat,
            "headline": f"{CATEGORY_LABELS[cat]}: 新着{len(members)}件 — {_short(members[0]['title'])}",
            "data": {
                "count": len(members),
                "sources": _source_counts(members),
                "items": [_item(e, cat) for e in members[:ITEM_LIMIT]],
            },
        })
    return episodes


def _source_counts(entries: list[dict]) -> list[dict]:
    c: dict[str, int] = {}
    for e in entries:
        k = e.get("platform") or e.get("source_type") or "?"
        c[k] = c.get(k, 0) + 1
    return [{"platform": k, "count": v} for k, v in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))]


# ------------------------------------------------------------------ キーワード(週次の差分)

# 見出しによく出るが、話題を表さない語(リリースノートの動詞・冠詞など)
_STOP = frozenset("""
the and for with from that this into your you are can how what why when about more all not has have will via per its
new now use using used add adds added fix fixes fixed improve improved improvements update updated updates support
supports supported change changes changed release released releases notes note version versions bug bugs issue issues
blog docs doc guide tutorial introduction intro overview part vs get got make makes made one two top best
is in on of to at by or as an it be we our out up if do no but not than then also only over under after before
""".split())

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#]*(?:[.\-][A-Za-z0-9+#]+)*")
_KATAKANA_RE = re.compile(r"[ァ-ヶー]{3,}")


def _tokens(entry: dict) -> set[str]:
    """記事1本の、話題を表す語(英字の語・カタカナ語)。同じ語は1回と数える。"""
    text = " ".join([str(entry.get("title", "")), " ".join(str(k) for k in (entry.get("keywords") or []) if not str(k).startswith("source:"))])
    out: set[str] = set()
    for w in _WORD_RE.findall(text):
        key = w.lower()
        if len(key) < 3 or key in _STOP or key.isdigit():
            continue
        out.add(key)
    for w in _KATAKANA_RE.findall(text):
        out.add(w)
    return out


def _display(word: str, entries: list[dict]) -> str:
    """表示用の綴り(記事の中で最初に見つかった綴り)。無ければそのまま。"""
    for e in entries:
        for w in _WORD_RE.findall(str(e.get("title", ""))):
            if w.lower() == word:
                return w
    return word


def week_keywords(members: list[dict], prev_members: list[dict], limit: int = 12) -> list[dict]:
    """
    今週よく出た語と、先週との差。count = その語を含む記事の数、prev = 先週の数、new = 先週は無かった語。
    1本の記事にしか出ない語は、記事が少ない週(合計6本未満)のときだけ載せる。
    """
    def count(entries):
        c: dict[str, int] = {}
        for e in _uniq(entries):
            for t in _tokens(e):
                c[t] = c.get(t, 0) + 1
        return c

    now, before = count(members), count(prev_members)
    floor = 2 if len(_uniq(members)) >= 6 else 1
    rows = [
        {"word": _display(w, members), "count": n, "prev": before.get(w, 0), "new": before.get(w, 0) == 0}
        for w, n in now.items() if n >= floor
    ]
    # 新出を先に、次に増えた語、次に件数。同じなら語の順で、結果が毎回同じになるようにする
    rows.sort(key=lambda r: (not r["new"], -(r["count"] - r["prev"]), -r["count"], r["word"].lower()))
    return rows[:limit]


# ------------------------------------------------------------------ 週次

def week_label(day: date) -> str:
    y, w, _ = day.isocalendar()
    return f"{y}-W{w:02d}"


def week_days(label: str) -> list[str]:
    """'2026-W41' → その週の月〜日の日付(YYYY-MM-DD)7つ。"""
    y, w = label.split("-W")
    monday = date.fromisocalendar(int(y), int(w), 1)
    return [(monday + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]


def build_weekly(entries: list[dict], label: str) -> list[dict]:
    """label: '2026-W41'(JSTのISO週)。件数0なら空リスト。"""
    days = week_days(label)
    members = [e for e in entries if _valid(e) and _entry_date(e) in days]
    if not members:
        return []
    prev_days = [(date.fromisoformat(d) - timedelta(days=7)).strftime("%Y-%m-%d") for d in days]
    prev_members = [e for e in entries if _valid(e) and _entry_date(e) in prev_days]

    ordered = _order(members)
    counts = _counts(members)
    top_cat = max(CATEGORIES, key=lambda c: counts["by_category"][c])

    daily = []
    for d in days:
        day_entries = _uniq([e for e in members if _entry_date(e) == d])
        row = {"date": d, "total": len(day_entries)}
        for c in CATEGORIES:
            row[c] = sum(1 for e in day_entries if c in e["categories"])
        daily.append(row)

    chapters = []
    for cat in CATEGORIES:
        cm = [e for e in ordered if cat in e["categories"]]
        chapters.append({
            "category": cat,
            "count": len(cm),
            "sources": _source_counts(cm)[:6],
            "items": [_item(e, cat) for e in cm[:CHAPTER_ITEMS]],
        })

    return [{
        "id": f"weekly:{label}:all",
        "kind": "weekly", "date": label, "category": None,
        "headline": f"{label}: 新着{counts['total']}件。最多は {CATEGORY_LABELS[top_cat]}({counts['by_category'][top_cat]}件)",
        "data": {
            "counts": counts,
            "days": days,
            "daily": daily,
            "highlights": [_item(e) for e in _uniq(ordered)[:3]],
            "chapters": chapters,
            # 今週よく出た語と、先週との差(新出・増えた語)。サイトの特集に出す
            "keywords": week_keywords(members, prev_members),
            "prev_total": len(_uniq(prev_members)),
        },
    }]


# ------------------------------------------------------------------ まとめて

def build_for_run(entries: list[dict], now: datetime) -> list[dict]:
    """
    送信する episode をまとめて作る。取りこぼし・日付や週の切り替わりに備えて、
    今日と昨日の日次、今週と先週の週次を作り直す(同じ id は受け口で上書きされる)。
    """
    today = now.astimezone(JST).date()
    out: list[dict] = []
    for d in (today, today - timedelta(days=1)):
        out += build_daily(entries, d.strftime("%Y-%m-%d"))
    for d in (today, today - timedelta(days=7)):
        out += build_weekly(entries, week_label(d))
    return out
