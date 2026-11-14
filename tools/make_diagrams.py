"""docs/diagrams/ の構成図(SVG)を作る。`python tools/make_diagrams.py` で作り直す。部品は tools/svgkit.py。"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from svgkit import Diagram  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "docs" / "diagrams"


def architecture() -> Diagram:
    d = Diagram(1500, 700, "Research-Collector の構成",
                "GitHub Actions が毎日、Zenn・Qiita・公式ブログ・論文などから新着を集め、URL と意味の近さで重複を除き、分類の補助を付けて、"
                "NotebookLM のノートブックへ追加し、週次のレポートと収集結果ビューを作る。任意で ResearchBroadcast へ送る。")
    d.text(40, 44, "Research-Collector — 構成", cls="hd")
    d.text(40, 66, "青=主な流れ / 灰の破線=任意。分類は補助で、迷ったら人の確認に回す", cls="note")

    d.group(40, 100, 250, 520, "SOURCES — 収集元", color="gray")
    src = d.card(150, 240, "globe", "記事・論文", "Zenn・Qiita・公式ブログ\narXiv・変更履歴 ほか")
    d.card(150, 440, "clock", "GitHub Actions", "毎日 6 時(論文は週 2 回)")

    d.group(480, 100, 760, 520, "PIPELINE — main.py と nbklm/", color="teal")
    col = d.card(640, 240, "extension", "collectors/", "ソースごとの収集")
    dup = d.card(900, 240, "check", "重複の除去", "URL(seen_urls)+\n意味(semantic_dedup)")
    cls = d.card(1160, 240, "tag", "classifier", "3 カテゴリ +「どれでもない」\n(補助)")
    nb = d.card(900, 440, "doc", "NotebookLM", "週次ノートブックへ追加\nレポート(水・日)")
    res = d.card(1160, 440, "list", "results.html", "収集結果ビュー・health.json")
    d.text(500, 602, "認証の自動更新: Windows のタスクスケジューラで 1 日 2 回", cls="note")

    d.group(1300, 100, 170, 520, "OPTION", color="purple")
    bc = d.card(1385, 440, "cloud", "broadcast/", "Cloudflare 上の\n別システム")

    d.arrow([src.right, col.left], "新着", at=0)
    d.arrow([col.right, dup.left], "", at=0)
    d.arrow([dup.right, cls.left], "代表だけ", at=0)
    d.arrow([cls.right, (1260, 240), (1260, 340), (900, 340), nb.top], "", at=0)
    d.arrow([nb.right, res.left], "", at=0)
    d.arrow([res.right, bc.left], "任意で送る", kind="secondary", at=0)
    return d


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "architecture.svg").write_text(architecture().svg(), encoding="utf-8")
    print("wrote", OUT / "architecture.svg")


if __name__ == "__main__":
    main()
