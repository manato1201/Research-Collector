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

    from health import write_health
    from collectors.retry import pop_failures, record_failure

    # 1. 認証確認
    from nbklm import check_auth
    if not check_auth():
        logger.error("Auth failed. Aborting.")
        write_health("daily", "error", error="auth failed")
        sys.exit(1)

    all_articles = []
    by_source = {}  # 収集元ごとの取得件数(health.json の by_source)

    def _collect(label, fn, unit="articles"):
        """1つの収集元を実行する。失敗しても他の収集元は継続する(失敗は health.json に記録)。"""
        try:
            articles = fn()
            all_articles.extend(articles)
            by_source[label] = len(articles)
            logger.info(f"{label}: {len(articles)} {unit}")
        except Exception as e:
            by_source[label] = 0
            logger.error(f"{label} collect failed: {e}")
            record_failure(label, e)

    # 2. Zenn / Qiita（5件/フィード × 13フィード）
    def _zenn_qiita():
        from collectors.zenn_qiita_collector import collect
        return collect(max_per_feed=5)
    _collect("Zenn/Qiita", _zenn_qiita)

    # 3. Unity / UE 公式ブログ（5件/フィード × 3フィード）
    def _unity_ue():
        from collectors.unity_ue_collector import collect
        return collect(max_per_feed=5)
    _collect("Unity/UE", _unity_ue)

    # 4. CEDEC（CEDiL:15件 + YouTube:10件 = 最大25件）
    def _cedec():
        from collectors.cedec_collector import collect
        return collect(max_cedil=15, max_youtube=10)
    _collect("CEDEC", _cedec, unit="items")

    # 5. 論文（月・木のみ / 3件/クエリ × 17クエリ = 最大51件）
    weekday = datetime.now().weekday()  # 0=月, 3=木
    if weekday in (0, 3):
        def _papers():
            from collectors.paper_collector import collect
            return collect(max_arxiv=3, max_semantic=3)
        _collect("Papers", _papers, unit="papers")
    else:
        logger.info("Papers: skipped (runs Mon/Thu only)")

    # 6. 更新情報（SideFX / Cloudflare 変更履歴 / モデル公開ページ）— S3
    def _release_notes():
        from collectors.release_notes_collector import collect
        return collect(max_per_feed=5)
    _collect("ReleaseNotes", _release_notes)

    # 7. X投稿（x_urls.txt に書いたURLのみ。取得済みは取りに行かない）— S4
    def _x_posts():
        from collectors.x_posts_collector import collect
        from nbklm.seen_urls import load_seen
        return collect(skip_hashes=load_seen())
    _collect("X posts", _x_posts, unit="posts")

    # 8. 配布サイトの新着監視（通知のみ。NotebookLMへは追加しない）— S5
    watch_new = []
    try:
        from collectors.watch_collector import check as check_watches
        watch_new = check_watches()
        for item in watch_new:
            logger.info(f"[watch] NEW {item['watch']}: {item['title']} {item['url']}")
    except Exception as e:
        logger.error(f"Watch failed: {e}")
        record_failure("watch", e)

    # 取得失敗の記録(health.json に残し、収集結果ビューの「失敗 n件」に出す)
    failures = pop_failures()
    if failures:
        logger.warning(f"Source failures: {len(failures)}")
    common = {
        "by_source":       by_source,
        "failed_sources":  len(failures),
        "source_failures": failures[:20],
        "watch_new":       len(watch_new),
    }

    logger.info(f"Total collected: {len(all_articles)}")

    if not all_articles:
        logger.warning("No articles collected. Exiting.")
        write_health("daily", "ok", collected=0, new=0, **common)
        return

    # 9. 同一実行内の重複除去
    seen_hash = set()
    deduped = []
    for a in all_articles:
        h = a.get("url_hash", a["url"])
        if h not in seen_hash:
            seen_hash.add(h)
            deduped.append(a)
    logger.info(f"After in-run dedup: {len(deduped)} articles")

    # 10. 過去実行分との重複チェック（seen_urls.txt）
    from nbklm.seen_urls import filter_new_articles, save_seen
    new_articles, updated_seen = filter_new_articles(deduped)

    if not new_articles:
        logger.info("All articles already seen. Nothing to add.")
        # seen_urls.txt は変更なし
        write_health("daily", "ok", collected=len(all_articles), new=0, **common)
        return

    logger.info(f"New articles to add: {len(new_articles)}")

    # 11. 分類の補助（S1）: 3カテゴリ + 「どれでもない」。どれでもないは人の確認に回す。
    #     実際の振り分け先(source_type 由来)は変えない。
    from nbklm import articles_log, semantic_dedup
    from nbklm.classifier import classify
    from nbklm.notebook_ids import SOURCE_TYPE_TO_CATEGORIES

    cls_by_hash = {
        a["url_hash"]: classify(
            a.get("title", ""), (a.get("text") or "")[:300], a.get("source_type", "")
        )
        for a in new_articles
    }
    unclassified = [a for a in new_articles if cls_by_hash[a["url_hash"]]["label"] == "none"]
    if unclassified:
        logger.warning(f"Unclassified (needs human review): {len(unclassified)}")
        for a in unclassified[:10]:
            logger.warning(f"  - [{a['source_type']}] {a['title'][:60]} {a['url']}")

    # 12. 意味での重複判定（S2）: 類似タイトルを代表1本に統合する(SEMANTIC_DEDUP=0 で無効)
    if semantic_dedup.enabled():
        to_add, merged = semantic_dedup.group_near_duplicates(
            new_articles, recent=articles_log.recent_added(days=14)
        )
        for m in merged:
            logger.info(f"  merged ({m['similarity']}): {m['title'][:50]} → {m['merged_into']}")
    else:
        to_add, merged = new_articles, []
    logger.info(f"Semantic dedup: {len(merged)} merged, {len(to_add)} to add")

    # 13. NotebookLM へ追加（週次ノートブックへ自動振り分け）
    if to_add:
        from nbklm import add_articles
        result = add_articles(to_add)
    else:
        result = {"ok": 0, "skip": 0, "errors": [], "added_urls": [], "failed_urls": []}
    logger.info(
        f"NotebookLM: ok={result['ok']}, skip={result['skip']}, "
        f"errors={len(result['errors'])}"
    )
    if result["errors"]:
        for err in result["errors"][:5]:
            logger.warning(f"  - {err}")

    # 14. seen_urls.txt を更新して永続化
    #     X投稿は追加に失敗しても「取得済み」にしない(次回の実行で再試行する)
    failed = set(result.get("failed_urls", []))
    for a in to_add:
        if a.get("source_type") == "x_post" and a["url"] in failed:
            updated_seen.discard(a["url_hash"])
    save_seen(updated_seen)

    # 15. 収集記事ログ(articles_log.json)に記録 — 意味重複の比較対象と収集結果ビューの入力
    added = set(result.get("added_urls", []))
    entries = []
    for a in to_add:
        status = articles_log.ADDED if a["url"] in added else articles_log.FAILED
        entries.append(articles_log.make_entry(
            a, status,
            SOURCE_TYPE_TO_CATEGORIES.get(a.get("source_type", ""), ["game_dev_tech"]),
            cls_by_hash[a["url_hash"]],
        ))
    for m in merged:
        entries.append(articles_log.make_entry(
            m, articles_log.MERGED,
            SOURCE_TYPE_TO_CATEGORIES.get(m.get("source_type", ""), ["game_dev_tech"]),
            cls_by_hash[m["url_hash"]], merged_into=m["merged_into"],
        ))
    try:
        articles_log.append(entries)
    except Exception as e:
        logger.error(f"articles_log save failed: {e}")

    # 16. Notion へ保存（任意）
    _save_to_notion(to_add)

    # 17. ノートブック容量上限に近づいていたら古いものから自動削除
    deleted_notebooks = []
    notebooks_total = None
    try:
        from nbklm import cleanup_notebooks
        from nbklm.notebook_cleanup import last_total
        deleted_notebooks = cleanup_notebooks()
        notebooks_total = last_total()
        if deleted_notebooks:
            logger.warning(
                f"[notebook_cleanup] capacity limit: deleted {len(deleted_notebooks)} "
                f"oldest notebooks: {deleted_notebooks}"
            )
    except Exception as e:
        logger.error(f"Notebook cleanup failed: {e}")

    write_health(
        "daily",
        "ok",
        collected=len(all_articles),
        new=len(new_articles),
        notebooklm_ok=result["ok"],
        notebooklm_skip=result["skip"],
        notebooklm_errors=len(result["errors"]),
        notebooks_deleted=len(deleted_notebooks),
        notebooks_total=notebooks_total,
        unclassified=len(unclassified),
        merged=len(merged),
        **common,
    )

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

    from health import write_health
    from nbklm import generate_weekly_digest

    report_md = generate_weekly_digest()

    if not report_md:
        logger.error("Weekly digest generation failed.")
        write_health("weekly", "error", error="digest generation failed")
        sys.exit(1)

    date_str = datetime.now().strftime("%Y-%m-%d")
    output_path = f"output/weekly_digest_{date_str}.md"
    os.makedirs("output", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(f"# Weekly Research Digest — {date_str}\n\n")
        f.write(report_md)
    logger.info(f"Saved: {output_path} ({len(report_md)} chars)")

    _save_digest_to_notion(report_md, date_str)
    write_health("weekly", "ok", chars=len(report_md))
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
