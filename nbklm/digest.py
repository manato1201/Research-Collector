"""
週次ダイジェストの組み立てと、ResearchBroadcast へ送るレポートへの変換

外部ライブラリに依存しない(nbklm/client.py と scripts/post_report.py の両方から使う)。

- `render_digest_markdown(parts)`: 従来と同じ Markdown(output/weekly_digest_*.md の本文)を作る。
- `parts_to_report(parts)`: サイトに出す形(セクションごとの Markdown)に変換する。
- `parse_digest_markdown(md, date_str)`: 保存済みの Markdown(GitHub の成果物など)から同じ形を作る。
  過去分の取り込み(バックフィル)用。見出し行(CATEGORY_LABELS と完全一致)で分割する。
  NotebookLM の本文にも `##` の見出しが含まれうるため、`##` 全般では分割しない。

隔離方針: 送るのは3カテゴリ(ALLOWED_CATEGORIES)のセクションだけ。それ以外のカテゴリ
(ローカル限定の分野)は、構造化された parts にあっても、Markdown に紛れていても、レポートに入らない。
"""

import re
from typing import Optional

CATEGORY_LABELS = {
    "game_dev_tech":        "## 🎮 ゲーム開発・エンジン技術",
    "graphics_research":    "## 🖥️ グラフィクス・レンダリング技術",
    "software_engineering": "## 📄 ソフトウェア工学・論文",
}

ALLOWED_CATEGORIES = tuple(CATEGORY_LABELS)

FAILURE_MARK = "> ⚠️"  # レポート生成に失敗したセクションの本文の先頭

# サイトに送る1セクションの上限(受け口は 120,000 字まで)
SECTION_MAX = 100_000

_EMOJI_PREFIX = re.compile(r"^##\s+[^\w぀-ヿ一-鿿]+\s*")


def plain_heading(label: str) -> str:
    """'## 🎮 ゲーム開発・エンジン技術' → 'ゲーム開発・エンジン技術'"""
    return _EMOJI_PREFIX.sub("", label).strip() or label.lstrip("# ").strip()


def render_digest_markdown(parts: dict) -> str:
    """parts から、従来と同じ形式の Markdown を作る。"""
    year, week, date_str = parts["year"], parts["week"], parts["date"]
    out = [
        f"# 週次リサーチダイジェスト — {year}-{week}（{date_str}）\n",
        "> **収集ノートブック:** " + "、".join(parts.get("notebooks", [])) + "\n",
        "> **生成日時:** " + parts.get("generated_label", "") + "\n",
    ]
    for s in parts["sections"]:
        out.append(f"\n{s['label']}\n")
        out.append(s["body"])
    return "\n".join(out)


def _ok(body: str) -> bool:
    return bool(body.strip()) and not body.lstrip().startswith(FAILURE_MARK)


def parts_to_report(parts: dict) -> Optional[dict]:
    """
    parts → 受け口に送るレポート。3カテゴリのセクションだけを入れる。
    内容のあるセクションが1つも無ければ None(失敗の注記だけのレポートは送らない)。
    """
    sections = []
    for s in parts.get("sections", []):
        cat = s.get("category")
        if cat not in ALLOWED_CATEGORIES:
            continue
        body = str(s.get("body", "")).strip()
        if not body:
            continue
        sections.append({
            "category": cat,
            "heading": plain_heading(s.get("label") or CATEGORY_LABELS[cat]),
            "markdown": body[:SECTION_MAX],
            "ok": _ok(body),
        })
    if not any(s["ok"] for s in sections):
        return None

    date = parts["date"]
    notebooks = "、".join(parts.get("notebooks", []))
    report = {
        "id": f"digest:{date}",
        "kind": "digest",
        "date": date,
        "title": f"週次リサーチダイジェスト — {parts['year']}-{parts['week']}",
        "week": f"{parts['year']}-{parts['week']}",
        "intro": f"収集ノートブック: {notebooks}" if notebooks else "",
        "sections": [{k: v for k, v in s.items() if k != "ok"} for s in sections],
    }
    if parts.get("generated_at"):
        report["generated_at"] = parts["generated_at"]
    return report


_TITLE_RE = re.compile(r"^#\s+週次リサーチダイジェスト\s+—\s+(\d{4})-(W\d{2})")
_NB_RE = re.compile(r"^>\s*\*\*収集ノートブック:\*\*\s*(.+)$")
_AT_RE = re.compile(r"^>\s*\*\*生成日時:\*\*\s*(\d{4})年(\d{2})月(\d{2})日\s+(\d{2}):(\d{2})")


def parse_digest_markdown(md: str, date_str: str) -> Optional[dict]:
    """保存済みの Markdown から、parts と同じ形を作る(バックフィル用)。作れなければ None。"""
    year = week = None
    notebooks: list[str] = []
    generated_label = ""
    sections: list[dict] = []
    current: Optional[dict] = None
    label_to_cat = {label: cat for cat, label in CATEGORY_LABELS.items()}

    for line in md.splitlines():
        stripped = line.strip()
        if stripped in label_to_cat:
            current = {"category": label_to_cat[stripped], "label": stripped, "lines": []}
            sections.append(current)
            continue
        if current is None:
            m = _TITLE_RE.match(line)
            if m and year is None:
                year, week = m.group(1), m.group(2)
                continue
            m = _NB_RE.match(line)
            if m:
                notebooks = [n.strip() for n in m.group(1).split("、") if n.strip()]
                continue
            m = _AT_RE.match(line)
            if m:
                generated_label = f"{m.group(1)}年{m.group(2)}月{m.group(3)}日 {m.group(4)}:{m.group(5)}"
            continue
        current["lines"].append(line)

    if year is None or not sections:
        return None
    return {
        "year": year,
        "week": week,
        "date": date_str,
        "generated_label": generated_label,
        "notebooks": notebooks,
        "sections": [
            {"category": s["category"], "label": s["label"], "body": "\n".join(s["lines"]).strip()}
            for s in sections
        ],
    }
