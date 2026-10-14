"""
記事の「解説」(これは何か / 何ができるか / どう応用できるか)を、ResearchBroadcast の Worker に作らせる

Worker の `POST /api/enrich`(Bearer のみ)を呼ぶ。生成は Worker 側の Workers AI(Cloudflare の無料枠。
1日 10,000 Neurons。1件あたり数十 Neurons)で、根拠は題名と要約だけ。1回の呼び出しで最大8件、
解説の無い新しい記事から順に作る。**任意の工程**: 環境変数が未設定なら何もしない。失敗しても収集には影響しない。

    python scripts/enrich.py [--rounds 3] [--limit 8]

環境変数: BROADCAST_INGEST_URL / BROADCAST_INGEST_TOKEN(post_ingest.py と同じ)
"""

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

logger = logging.getLogger("enrich")


def enrich_url(ingest_url: str, limit: int) -> str:
    base = ingest_url[: -len("/api/ingest")] if ingest_url.endswith("/api/ingest") else ingest_url.rstrip("/")
    return f"{base}/api/enrich?limit={limit}"


def call(url: str, token: str, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        url, data=b"{}", method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": "research-collector/1.0 (enrich)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run(url: str, token: str, rounds: int, limit: int, post=call) -> dict:
    """解説が無い記事が無くなる・上限の回数・生成が続けて失敗する、のいずれかまで繰り返す。集計を返す。"""
    total = {"processed": 0, "ok": 0, "unusable": 0, "errors": 0, "pending": None, "rounds": 0}
    for _ in range(rounds):
        r = post(enrich_url(url, limit), token)
        total["rounds"] += 1
        for k in ("processed", "ok", "unusable", "errors"):
            total[k] += int(r.get(k, 0))
        total["pending"] = r.get("pending")
        if r.get("processed", 0) == 0 or r.get("pending", 0) == 0:
            break
        if r.get("ok", 0) == 0 and r.get("errors", 0) > 0:
            break  # AI が使えない状態。枠と時間を使い続けない
    return total


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="記事の解説を、Worker の Workers AI で作らせる")
    ap.add_argument("--rounds", type=int, default=3, help="最大の呼び出し回数(1回 最大 --limit 件)")
    ap.add_argument("--limit", type=int, default=8)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    url = os.environ.get("BROADCAST_INGEST_URL", "").strip()
    token = os.environ.get("BROADCAST_INGEST_TOKEN", "").strip()
    if not (url and token):
        logger.info("BROADCAST_INGEST_URL / BROADCAST_INGEST_TOKEN not set — skipping (optional step)")
        return 0
    import post_ingest  # https のときだけ Bearer を送る
    if not post_ingest.allowed_url(url):
        logger.error("BROADCAST_INGEST_URL must be https://")
        return 1
    try:
        t = run(url, token, args.rounds, args.limit)
    except urllib.error.HTTPError as e:
        logger.error(f"enrich failed: HTTP {e.code}")
        return 1
    except Exception as e:
        logger.error(f"enrich failed: {e}")
        return 1
    logger.info(
        f"enrich: {t['ok']} written, {t['unusable']} unusable, {t['errors']} errors "
        f"in {t['rounds']} round(s); {t['pending']} still pending"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
