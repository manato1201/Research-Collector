"""
実行結果のヘルスステータス管理
daily_collect / weekly_digest の最新の実行結果を health.json に記録する。
README.md の簡易表はこの health.json を元に scripts/update_readme_health.py が生成する。
"""

import json
import logging
import os
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

HEALTH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "health.json")


def _load() -> dict:
    if not os.path.exists(HEALTH_FILE):
        return {}
    try:
        with open(HEALTH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def write_health(mode: str, status: str, **fields) -> None:
    """
    mode: "daily" | "weekly"
    status: "ok" | "error"
    fields: collected, new, notebooklm_ok, notebooklm_skip, notebooklm_errors, error など任意
    """
    data = _load()
    data[mode] = {
        "status": status,
        "run_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **fields,
    }
    with open(HEALTH_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"[health] {mode}: {status}")
