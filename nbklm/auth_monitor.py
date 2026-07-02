"""
Cookie失効の事前検知
storage_state.json内のCookie群から最短失効日を計算し、
事前にリフレッシュが必要かどうかを判定する。

Usage (CI):
    python -m nbklm.auth_monitor
    # GITHUB_OUTPUT に days_remaining / needs_refresh を書き出す
"""

import json
import logging
import os
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_STORAGE_PATH = Path.home() / ".notebooklm" / "storage_state.json"
WARNING_THRESHOLD_DAYS = 10


def load_storage_state() -> dict:
    """NOTEBOOKLM_AUTH_JSON環境変数、なければデフォルトパスから読み込む"""
    auth_json = os.environ.get("NOTEBOOKLM_AUTH_JSON", "").strip()
    if auth_json:
        return json.loads(auth_json)
    return json.loads(DEFAULT_STORAGE_PATH.read_text(encoding="utf-8"))


def check_cookie_expiry(storage_state: dict) -> tuple[int, bool]:
    """
    Cookie群のexpires最小値から残日数を計算する。
    Google認証系(google.comドメイン)のCookieのみを対象にする。

    戻り値: (days_remaining, needs_refresh)
    有効期限付きCookieが1つも見つからない場合は判定不能とみなし、
    安全側に倒して (0, True) を返す。
    """
    cookies = storage_state.get("cookies", [])
    expires_list = [
        c["expires"]
        for c in cookies
        if "google.com" in c.get("domain", "") and c.get("expires", -1) > 0
    ]

    if not expires_list:
        return 0, True

    min_expires = min(expires_list)
    days_remaining = int((min_expires - time.time()) // 86400)
    needs_refresh = days_remaining < WARNING_THRESHOLD_DAYS
    return days_remaining, needs_refresh


def main():
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
    )

    try:
        storage_state = load_storage_state()
        days_remaining, needs_refresh = check_cookie_expiry(storage_state)
        logger.info(
            f"Cookie残日数: {days_remaining}日 (needs_refresh={needs_refresh})"
        )
    except Exception as e:
        # 読み込み失敗はここでは致命的に扱わない。実際の認証切れは
        # main.py --mode check の方で別途検知される。
        logger.warning(f"storage_state読み込み失敗、判定をスキップ: {e}")
        days_remaining, needs_refresh = -1, False

    github_output = os.environ.get("GITHUB_OUTPUT")
    lines = [
        f"days_remaining={days_remaining}\n",
        f"needs_refresh={'true' if needs_refresh else 'false'}\n",
    ]
    if github_output:
        with open(github_output, "a", encoding="utf-8") as f:
            f.writelines(lines)
    else:
        sys.stdout.writelines(lines)


if __name__ == "__main__":
    main()
