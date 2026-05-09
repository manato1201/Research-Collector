"""
research-collector メインスクリプト
Usage:
    python main.py --mode daily     # 毎日収集 + NotebookLM追加
    python main.py --mode weekly    # 週次Digest生成
    python main.py --mode check     # 認証チェックのみ
"""

import argparse
import logging
import os
import sys
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
#  認証チェック
# ------------------------------------------------------------------ #

def run_check():
    from nbklm import check_auth
    ok = check_auth()
    if not ok:
        logger.error("NotebookLM auth failed. Re-run: notebooklm login")
        sys.exit(1)
    logger.info("Auth OK.")


# ------------------------------------------------------------------ #
#  デイリー収集
# ------------------------------------------------------------------ #

def run_daily():
    logger.info("=== Daily Collect Start ===")

    # 1. 認証確認
    from nbklm import check_auth
    if not check_auth():
        logger.error("Auth failed. Aborting.")
        sys.exit(1)

    all_articles = []

    # 2. Zenn / Qiita
    try:
        from collectors.zenn_qiita_collector import collect as collect_zenn_qiita
        articles = collect_zenn_qiita(max_per_feed=20)
        all_articles.extend(articles)
        logger.info(f"Zenn/Qiita: {len(articles)} articles")
    except Exception as e:
        logger.error(f"Zenn/Qiita collect failed: {e}")

    # 3. Unity / UE 公式ブログ
    try:
        from collectors.unity_ue_collector import collect as collect_unity_ue
        articles = collect_unity_ue(max_per_feed=10)
        all_articles.extend(articles)
        logger.info(f"Unity/UE: {len(articles)} articles")
    except Exception as e:
        logger.error(f"Unity/UE collect failed: {e}")

    # 4. CEDEC（CEDiL新着 + YouTube）
    try:
        from collectors.cedec_collector import collect as collect_cedec
        articles = collect_cedec(max_cedil=30, max_youtube=20)
        all_articles.extend(articles)
        logger.info(f"CEDEC: {len(articles)} items")
    except Exception as e:
        logger.error(f"CEDEC collect failed: {e}")

    # 5. 論文（arXiv + Semantic Scholar）
    # 毎日ではなく週2回（月・木）のみ実行（APIレート制限対策）
    weekday = datetime.now().weekday()  # 0=月, 3=木
    if weekday in (0, 3):
        try:
            from collectors.paper_collector import collect as collect_papers
            articles = collect_papers(max_arxiv=5, max_semantic=5)
            all_articles.extend(articles)
            logger.info(f"Papers: {len(articles)} papers")
        except Exception as e:
            logger.error(f"Paper collect failed: {e}")
    else:
        logger.info("Papers: skipped (runs Mon/Thu only)")

    logger.info(f"Total collected: {len(all_articles)}")

    if not all_articles:
        logger.warning("No articles collected. Exiting.")
        return

    # 6. 重複除去
    seen = set()
    unique_articles = []
    for a in all_articles:
        h = a.get("url_hash", a["url"])
        if h not in seen:
            seen.add(h)
            unique_articles.append(a)
    logger.info(f"After dedup: {len(unique_articles)} articles")

    # 7. NotebookLM へ追加
    from nbklm import add_articles
    result = add_articles(unique_articles)
    logger.info(
        f"NotebookLM: ok={result['ok']}, skip={result['skip']}, "
        f"errors={len(result['errors'])}"
    )
    if result["errors"]:
        for err in result["errors"][:5]:
            logger.warning(f"  - {err}")

    # 8. Notion へ保存（任意）
    _save_to_notion(unique_articles)

    logger.info("=== Daily Collect Done ===")


def _save_to_notion(articles: list[dict]):
    try:
        from notion.client import save_articles
        saved = save_articles(articles)
        logger.info(f"Notion: {saved} articles saved")
    except ImportError:
        logger.info("Notion client not found, skipping.")
    except Exception as e:
        logger.error(f"Notion save failed: {e}")


# ------------------------------------------------------------------ #
#  週次 Digest
# ------------------------------------------------------------------ #

def run_weekly():
    logger.info("=== Weekly Digest Start ===")

    from nbklm import generate_weekly_digest

    report_md = generate_weekly_digest()

    if not report_md:
        logger.error("Weekly digest generation failed.")
        sys.exit(1)

    date_str = datetime.now().strftime("%Y-%m-%d")
    output_path = f"output/weekly_digest_{date_str}.md"
    os.makedirs("output", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(f"# Weekly Research Digest — {date_str}\n\n")
        f.write(report_md)
    logger.info(f"Saved: {output_path} ({len(report_md)} chars)")

    _save_digest_to_notion(report_md, date_str)

    logger.info("=== Weekly Digest Done ===")


def _save_digest_to_notion(report_md: str, date_str: str):
    try:
        from notion.client import save_digest
        save_digest(title=f"Weekly Digest {date_str}", content=report_md)
        logger.info("Notion: digest saved")
    except ImportError:
        logger.info("Notion digest client not found, skipping.")
    except Exception as e:
        logger.error(f"Notion digest save failed: {e}")


# ------------------------------------------------------------------ #
#  エントリーポイント
# ------------------------------------------------------------------ #

def main():
    parser = argparse.ArgumentParser(description="research-collector")
    parser.add_argument(
        "--mode",
        choices=["daily", "weekly", "check"],
        default="daily",
        help="実行モード (default: daily)",
    )
    args = parser.parse_args()

    if args.mode == "check":
        run_check()
    elif args.mode == "daily":
        run_daily()
    elif args.mode == "weekly":
        run_weekly()


if __name__ == "__main__":
    main()