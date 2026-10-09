"""
配布サイトの新着監視(通知のみ) — IMPROVEMENT_PLAN_2026-10.md S5

スキル・プラグインの配布サイトを定期的に見て、**一覧に新しく現れたもの**を検知する。
このモジュールは「知らせる」だけで、導入(ダウンロード・インストール・NotebookLMへの追加)は
一切しない。導入するかどうかは、人が SKILL.md などの中身を確認してから決める運用。

- 初回実行は現状の一覧を「既知」として保存するだけで、通知しない(数百件の誤通知を避ける)。
- 検知結果は watch_state.json の recent に残り、収集結果ビュー(results.html)に表示される。
"""

import json
import logging
import os
import re
import urllib.request
from datetime import datetime, timezone

from .retry import record_failure, retry

logger = logging.getLogger(__name__)

STATE_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "watch_state.json"
)

# name: 表示名 / url: 監視ページ / link_re: 項目リンクの正規表現(group(1)=サイト内パス) / base: リンクの基底URL
WATCHES = [
    {
        "name":    "skills.sh",
        "url":     "https://skills.sh/",
        "link_re": r'href="(/[^"/]+/[^"/]+/[^"/]+)"',
        "base":    "https://skills.sh",
    },
]

MAX_KNOWN = 3000   # 既知として覚えておく最大件数
MAX_RECENT = 50    # 直近の検知として残す最大件数


@retry(times=3, base_delay=2.0)
def _fetch_page(url: str) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (research-collector watch bot)"}
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_links(page_html: str, link_re: str) -> list[str]:
    """ページ内の項目パスを、出現順を保って重複なく返す。"""
    seen, out = set(), []
    for path in re.findall(link_re, page_html):
        if path not in seen:
            seen.add(path)
            out.append(path)
    return out


def _load_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"[watch] state load failed, starting empty: {e}")
        return {}


def _save_state(state: dict) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


def _title_from_path(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 3:
        return f"{parts[0]}/{parts[1]} · {parts[2]}"
    return path


def check(watches: list[dict] | None = None) -> list[dict]:
    """
    監視対象を巡回し、新しく現れた項目を返す。

    Returns
    -------
    list[dict]  各要素: watch(監視名), title, url, detected_at
    """
    watches = WATCHES if watches is None else watches
    state = _load_state()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    detected: list[dict] = []

    for w in watches:
        name = w["name"]
        try:
            links = extract_links(_fetch_page(w["url"]), w["link_re"])
            if not links:
                raise RuntimeError("no links found (page layout may have changed)")
        except Exception as e:
            logger.warning(f"[watch:{name}] failed: {e}")
            record_failure(f"watch:{name}", e)
            continue

        entry = state.setdefault(name, {"known": [], "recent": [], "initialized": None})
        known = set(entry.get("known", []))

        if not entry.get("initialized"):
            entry["initialized"] = now
            logger.info(f"[watch:{name}] initialized with {len(links)} known items (no notification)")
        else:
            for path in links:
                if path not in known:
                    item = {
                        "watch":       name,
                        "title":       _title_from_path(path),
                        "url":         w["base"] + path,
                        "detected_at": now,
                    }
                    detected.append(item)
            if detected:
                logger.info(f"[watch:{name}] {len(detected)} new items detected")

        link_set = set(links)
        entry["known"] = (list(links) + [p for p in entry.get("known", []) if p not in link_set])[:MAX_KNOWN]
        entry["recent"] = (
            [d for d in detected if d["watch"] == name] + entry.get("recent", [])
        )[:MAX_RECENT]

    _save_state(state)
    return detected


def recent(limit: int = 20) -> list[dict]:
    """収集結果ビュー用: 全監視対象の直近の検知を新しい順で返す。"""
    state = _load_state()
    items = [it for e in state.values() for it in e.get("recent", [])]
    items.sort(key=lambda i: i.get("detected_at", ""), reverse=True)
    return items[:limit]
