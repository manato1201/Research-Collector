"""
週次ダイジェスト(レポート)を ResearchBroadcast の Worker(`POST /api/ingest` の `reports`)へ送る

週次ワークフロー(weekly_digest.yml)が `main.py --mode weekly` で作った
`output/weekly_digest_YYYY-MM-DD.md`(と、同じ名前の `.json` = セクションごとの構造化データ)を送る。
サイトの「レポート」ページに、カテゴリ別のセクションとして表示される。

- 環境変数が未設定なら何もしない(任意の工程。post_ingest.py と同じ)。
- 同じ日付のレポートは `digest:YYYY-MM-DD` で上書きされる(冪等)。
- **3カテゴリ(game_dev_tech / graphics_research / software_engineering)のセクションだけ**を送る。
  構造化データ(.json)があればそれを使い、無ければ .md を、見出し行(CATEGORY_LABELS と完全一致)で分割する。
- 内容のあるセクションが1つも無い(すべて生成失敗の注記)レポートは送らない。

    python scripts/post_report.py output/weekly_digest_2026-10-11.md [...] [--dry-run]

過去分の取り込み(バックフィル): GitHub の成果物(weekly-digest-*)を展開した .md を渡す。
"""

import argparse
import glob
import json
import logging
import os
import re
import sys
import urllib.error
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import post_ingest  # noqa: E402  (post / allowed_url / SCHEMA_VERSION を共有する)
from nbklm import digest  # noqa: E402

logger = logging.getLogger("post_report")

MAX_REPORTS_PER_REQUEST = 5  # 受け口の上限(MAX_REPORTS)に合わせる
_DATE_IN_NAME = re.compile(r"weekly_digest_(\d{4}-\d{2}-\d{2})")


def load_report(path: str):
    """1つのダイジェストのファイルから、送るレポートを作る。作れなければ None。"""
    m = _DATE_IN_NAME.search(os.path.basename(path))
    if not m:
        logger.warning(f"skip (unexpected file name): {path}")
        return None
    date_str = m.group(1)

    base, ext = os.path.splitext(path)
    json_path = base + ".json"
    parts = None
    if ext.lower() == ".json" or os.path.exists(json_path):
        try:
            with open(path if ext.lower() == ".json" else json_path, "r", encoding="utf-8") as f:
                parts = json.load(f)
            parts.setdefault("date", date_str)
        except Exception as e:
            logger.warning(f"structured digest unreadable, falling back to markdown: {e}")
            parts = None
    if parts is None and ext.lower() == ".md":
        with open(path, "r", encoding="utf-8") as f:
            parts = digest.parse_digest_markdown(f.read(), date_str)
    if not parts:
        logger.warning(f"skip (no digest sections found): {path}")
        return None

    report = digest.parts_to_report(parts)
    if report is None:
        logger.warning(f"skip (no section with content): {path}")
    return report


def build_requests(reports: list[dict], now: datetime) -> list[dict]:
    """受け口の上限(1回5件)に分けた、送信するJSONのリスト。"""
    sent_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    out = []
    for i in range(0, len(reports), MAX_REPORTS_PER_REQUEST):
        out.append({
            "schema": post_ingest.SCHEMA_VERSION,
            "sent_at": sent_at,
            "reports": reports[i:i + MAX_REPORTS_PER_REQUEST],
        })
    return out


def expand(paths: list[str]) -> list[str]:
    files: list[str] = []
    for p in paths:
        hits = sorted(glob.glob(p)) or ([p] if os.path.exists(p) else [])
        files.extend(h for h in hits if h.lower().endswith((".md", ".json")))
    # 同じ名前の .md と .json は1本として扱う(load_report が両方を見る)
    seen, out = set(), []
    for f in files:
        key = os.path.splitext(f)[0]
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="週次ダイジェストを ResearchBroadcast へ送る")
    ap.add_argument("files", nargs="*", help="output/weekly_digest_*.md(glob 可)")
    ap.add_argument("--dry-run", action="store_true", help="送らず、送る内容の集計だけ表示する")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    url = os.environ.get("BROADCAST_INGEST_URL", "").strip()
    token = os.environ.get("BROADCAST_INGEST_TOKEN", "").strip()
    if not args.dry_run and not (url and token):
        logger.info("BROADCAST_INGEST_URL / BROADCAST_INGEST_TOKEN not set — skipping (optional step)")
        return 0
    if url and not post_ingest.allowed_url(url):
        logger.error("BROADCAST_INGEST_URL must be https:// (the bearer token must not be sent in clear text)")
        return 1

    paths = expand(args.files or [os.path.join(ROOT, "output", "weekly_digest_*.md")])
    reports = []
    for p in paths:
        r = load_report(p)
        if r:
            reports.append(r)
    # 同じ id は後のもの(ファイル名の日付が新しい方)を残す
    by_id = {r["id"]: r for r in reports}
    reports = [by_id[k] for k in sorted(by_id)]

    logger.info(
        f"report: {len(reports)} digest(s) from {len(paths)} file(s): "
        + ", ".join(f"{r['id']}({len(r['sections'])} sections)" for r in reports)
    )
    if args.dry_run or not reports:
        return 0

    now = datetime.now(timezone.utc)
    for i, req in enumerate(build_requests(reports, now), 1):
        try:
            resp = post_ingest.post(url, token, req)
            logger.info(f"request {i} ok: {resp}")
        except urllib.error.HTTPError as e:
            logger.error(f"request {i} failed: HTTP {e.code}")
            return 1
        except Exception as e:
            logger.error(f"request {i} failed: {e}")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
