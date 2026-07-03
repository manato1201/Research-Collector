"""
health.json の内容を README.md の運用ステータス表に反映する。
README.md 内の <!-- HEALTH_START --> 〜 <!-- HEALTH_END --> の間を書き換える。
"""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEALTH_FILE = os.path.join(ROOT, "health.json")
README_FILE = os.path.join(ROOT, "README.md")

START_MARKER = "<!-- HEALTH_START -->"
END_MARKER = "<!-- HEALTH_END -->"


def _status_emoji(status: str) -> str:
    return "✅" if status == "ok" else "⚠️"


def _row(mode_label: str, entry: dict) -> str:
    if not entry:
        return f"| {mode_label} | - | - |"
    status = _status_emoji(entry.get("status", "unknown"))
    run_at = entry.get("run_at", "-")
    if entry.get("status") != "ok":
        detail = entry.get("error", "unknown error")
    elif "new" in entry:
        detail = (
            f"収集{entry.get('collected', 0)}件 / 新規{entry.get('new', 0)}件 / "
            f"NotebookLM追加{entry.get('notebooklm_ok', 0)}件"
        )
    elif "chars" in entry:
        detail = f"{entry['chars']}文字生成"
    else:
        detail = "-"
    return f"| {mode_label} | {status} {run_at} | {detail} |"


def build_table(health: dict) -> str:
    lines = [
        "| 実行 | 最終実行 | 詳細 |",
        "|---|---|---|",
        _row("Daily Collect", health.get("daily", {})),
        _row("Weekly Digest", health.get("weekly", {})),
    ]
    return "\n".join(lines)


def main():
    if not os.path.exists(HEALTH_FILE):
        print("health.json not found, skipping README update.")
        return

    with open(HEALTH_FILE, "r", encoding="utf-8") as f:
        health = json.load(f)

    with open(README_FILE, "r", encoding="utf-8") as f:
        readme = f.read()

    table = build_table(health)
    new_section = f"{START_MARKER}\n{table}\n{END_MARKER}"

    pattern = re.compile(
        re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER), re.DOTALL
    )
    if not pattern.search(readme):
        print("HEALTH markers not found in README.md, skipping.")
        return

    updated = pattern.sub(new_section, readme)

    with open(README_FILE, "w", encoding="utf-8") as f:
        f.write(updated)
    print("README.md health section updated.")


if __name__ == "__main__":
    main()
