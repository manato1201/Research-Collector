"""
ResearchBroadcast のデータ(D1)を、この PC にバックアップする

サイトの `GET /api/export`(Bearer のみ・1回 最大200行)を、テーブルごとにたどって、
1つの gzip 圧縮 JSON にする。**公開リポジトリには置かない**(ボードのメモ・設定・追加分野の記事を含むため)。
出力先の `backup/` は .gitignore 対象。GitHub の成果物(public リポジトリでは公開される)にも載せない。

    python scripts/backup_d1.py                 # backup/research-broadcast-YYYY-MM-DD.json.gz を作る
    python scripts/backup_d1.py --if-older-than 6   # 最新のバックアップが6日より古いときだけ作る(日次タスクから呼ぶ用)
    python scripts/backup_d1.py --keep 8        # 古いバックアップを、新しい8本だけ残す(既定8)

接続先と認証: 環境変数 BROADCAST_INGEST_URL / BROADCAST_INGEST_TOKEN、無ければ broadcast/.deploy-secrets.txt。

復元: D1 の Time Travel(`npx wrangler d1 time-travel restore research-broadcast --timestamp …`。Free は直近7日)が
第一の手段。この書き出しは、それより古い時点・別のアカウントへの移行・中身の確認用。
"""

import argparse
import glob
import gzip
import json
import logging
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP_DIR = os.path.join(ROOT, "backup")
TABLES = ("articles", "episodes", "reports", "board", "watch", "prefs", "meta")
PAGE = 200

logger = logging.getLogger("backup_d1")


def load_config(env=None, root: str = ROOT):
    env = os.environ if env is None else env
    url = env.get("BROADCAST_INGEST_URL", "").strip()
    token = env.get("BROADCAST_INGEST_TOKEN", "").strip()
    if url and token:
        base = url[: -len("/api/ingest")] if url.endswith("/api/ingest") else url.rstrip("/")
        return base, token
    try:
        text = open(os.path.join(root, "broadcast", ".deploy-secrets.txt"), encoding="utf-8").read()
        m_url = re.search(r"^URL=(\S+)", text, re.M)
        m_tok = re.search(r"^INGEST_TOKEN=(\S+)", text, re.M)
        if m_url and m_tok:
            return m_url.group(1).rstrip("/"), m_tok.group(1)
    except OSError:
        pass
    return "", ""


def _get(base: str, token: str, path: str, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        base + path,
        headers={"Authorization": f"Bearer {token}", "User-Agent": "research-collector/1.0 (backup)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def export_all(base: str, token: str, fetch=_get) -> dict:
    """全テーブルをページごとに取得する。fetch は、テストで差し替えられる。"""
    out = {}
    for table in TABLES:
        rows, offset, pages = [], 0, 0
        while offset is not None and pages < 500:
            page = fetch(base, token, f"/api/export?table={table}&offset={offset}&limit={PAGE}")
            rows.extend(page.get("rows", []))
            offset = page.get("next")
            pages += 1
        out[table] = rows
    return out


def latest_backup_age_days(directory: str = BACKUP_DIR, now: float | None = None):
    files = glob.glob(os.path.join(directory, "research-broadcast-*.json.gz"))
    if not files:
        return None
    newest = max(os.path.getmtime(f) for f in files)
    return ((now if now is not None else time.time()) - newest) / 86400


def prune(directory: str, keep: int) -> list[str]:
    files = sorted(glob.glob(os.path.join(directory, "research-broadcast-*.json.gz")))
    old = files[: max(0, len(files) - keep)]
    for f in old:
        os.remove(f)
    return old


def write_backup(tables: dict, directory: str = BACKUP_DIR, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"research-broadcast-{now.strftime('%Y-%m-%d')}.json.gz")
    payload = {"exported_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "counts": {k: len(v) for k, v in tables.items()}, "tables": tables}
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    return path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="ResearchBroadcast のデータ(D1)をこの PC にバックアップする")
    ap.add_argument("--if-older-than", type=float, default=None, help="最新のバックアップが、この日数より古いときだけ作る")
    ap.add_argument("--keep", type=int, default=8)
    ap.add_argument("--out", default=BACKUP_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    if args.if_older_than is not None:
        age = latest_backup_age_days(args.out)
        if age is not None and age < args.if_older_than:
            logger.info(f"latest backup is {age:.1f} days old — skipping")
            return 0

    base, token = load_config()
    if not (base and token):
        logger.info("BROADCAST_INGEST_URL / TOKEN not configured — skipping")
        return 0
    try:
        tables = export_all(base, token)
    except Exception as e:
        logger.error(f"export failed: {e}")
        return 1
    path = write_backup(tables, args.out)
    removed = prune(args.out, args.keep)
    logger.info(
        f"backup written: {path} ({', '.join(f'{k} {len(v)}' for k, v in tables.items())})"
        + (f"; removed {len(removed)} old" if removed else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
