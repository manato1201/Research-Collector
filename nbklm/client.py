"""
notebooklm-py ラッパー
週次ノートブック自動作成・重複チェック対応版
最新API対応: CLI サブプロセス方式
"""

import asyncio
import json
import logging
import os
import subprocess
import tempfile
from datetime import datetime
from typing import Optional

from notebooklm import NotebookLMClient

from .notebook_ids import (
    NOTEBOOK_IDS_FIXED,
    SOURCE_TYPE_TO_CATEGORIES,
    CATEGORY_TO_NOTEBOOK_NAME,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
#  認証クライアント生成
# ------------------------------------------------------------------ #

async def _make_client() -> NotebookLMClient:
    auth_json = os.environ.get("NOTEBOOKLM_AUTH_JSON", "").strip()

    if auth_json:
        logger.info("[NotebookLM] using NOTEBOOKLM_AUTH_JSON env var")
        try:
            json.loads(auth_json)
        except json.JSONDecodeError as e:
            raise ValueError(f"NOTEBOOKLM_AUTH_JSON is not valid JSON: {e}")

        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        )
        tmp.write(auth_json)
        tmp.flush()
        tmp.close()
        return await NotebookLMClient.from_storage(path=tmp.name)
    else:
        logger.info("[NotebookLM] using default storage_state.json")
        return await NotebookLMClient.from_storage()


# ------------------------------------------------------------------ #
#  週次ノートブック管理
# ------------------------------------------------------------------ #

_weekly_nb_cache: dict[str, str] = {}


def _weekly_label() -> tuple[str, str]:
    now = datetime.now()
    year, week, _ = now.isocalendar()
    return str(year), f"W{week:02d}"


def _weekly_name(category: str, year: str, week: str) -> str:
    tpl = CATEGORY_TO_NOTEBOOK_NAME.get(category, "Research-{YYYY}-{WNN}")
    return tpl.replace("{YYYY}", year).replace("{WNN}", week)


async def _get_or_create_weekly_notebook(
    client: NotebookLMClient,
    category: str,
    year: str,
    week: str,
) -> str:
    cache_key = f"{category}:{year}:{week}"
    if cache_key in _weekly_nb_cache:
        return _weekly_nb_cache[cache_key]

    target_name = _weekly_name(category, year, week)

    notebooks = await client.notebooks.list()
    for nb in notebooks:
        if nb.title == target_name:
            logger.info(f"[NotebookLM] found: {target_name}")
            _weekly_nb_cache[cache_key] = nb.id
            return nb.id

    logger.info(f"[NotebookLM] creating: {target_name}")
    new_nb = await client.notebooks.create(title=target_name)
    logger.info(f"[NotebookLM] created: {target_name} ({new_nb.id[:8]}...)")
    _weekly_nb_cache[cache_key] = new_nb.id
    return new_nb.id


# ------------------------------------------------------------------ #
#  記事URLの一括追加
# ------------------------------------------------------------------ #

async def add_articles_to_notebooklm(articles: list[dict]) -> dict:
    result = {"ok": 0, "skip": 0, "errors": []}
    year, week = _weekly_label()

    async with await _make_client() as client:
        for article in articles:
            url = article.get("url", "")
            source_type = article.get("source_type", "zenn")
            categories = SOURCE_TYPE_TO_CATEGORIES.get(
                source_type, ["game_dev_tech"]
            )

            for category in categories:
                nb_id = await _get_or_create_weekly_notebook(
                    client, category, year, week
                )
                nb_name = _weekly_name(category, year, week)
                try:
                    await client.sources.add_url(nb_id, url, wait=False)
                    logger.info(f"[NotebookLM] added to {nb_name}: {url[:60]}")
                    result["ok"] += 1
                except Exception as e:
                    msg = f"{url[:50]} → {nb_name} → {e}"
                    logger.warning(f"[NotebookLM] skip: {msg}")
                    result["skip"] += 1
                    result["errors"].append(msg)

    return result


def add_articles(articles: list[dict]) -> dict:
    return asyncio.run(add_articles_to_notebooklm(articles))


# ------------------------------------------------------------------ #
#  論文PDFの追加
# ------------------------------------------------------------------ #

async def add_paper_async(pdf_path: str, title: Optional[str] = None) -> bool:
    year, week = _weekly_label()
    async with await _make_client() as client:
        nb_id = await _get_or_create_weekly_notebook(
            client, "software_engineering", year, week
        )
        try:
            await client.sources.add_file(nb_id, pdf_path, wait=False)
            logger.info(f"[NotebookLM] paper added: {pdf_path}")
            return True
        except Exception as e:
            logger.error(f"[NotebookLM] paper failed: {e}")
            return False


def add_paper(pdf_path: str, title: Optional[str] = None) -> bool:
    return asyncio.run(add_paper_async(pdf_path, title))


# ------------------------------------------------------------------ #
#  週次 Digest 生成（CLI サブプロセス方式）
# ------------------------------------------------------------------ #

WEEKLY_RESEARCH_QUERIES = [
    "Unity 最新アップデート 2026",
    "Unreal Engine 新機能 2026",
    "DirectX12 HLSL リアルタイムレンダリング",
    "ゲームエンジン 技術 最新",
]

WEEKLY_REPORT_PROMPT = (
    "ゲーム開発・グラフィクス技術の週次まとめレポートを日本語で作成してください。"
    "対象: Unity/UE最新動向、DirectX12/HLSL技術、CG論文ピックアップ。"
    "フォーマット: 1.今週のハイライト 2.Unity/UE注目トピック "
    "3.グラフィクス技術 4.論文ピックアップ 5.来週の注目動向。"
    "対象読者: ゲームエンジン・ツールエンジニアを目指す学生。"
)


def _run_cli(args: list[str], timeout: int = 300) -> tuple[bool, str]:
    """
    notebooklm CLI をサブプロセスで実行する。
    NOTEBOOKLM_AUTH_JSON 環境変数を引き継いで実行する。
    """
    try:
        result = subprocess.run(
            ["notebooklm"] + args,
            capture_output=True,
            text=True,
            env=os.environ.copy(),  # 認証環境変数を引き継ぐ
            timeout=timeout,
        )
        success = result.returncode == 0
        output = result.stdout + result.stderr
        if not success:
            logger.debug(f"[CLI] failed: {output[:300]}")
        return success, output
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as e:
        return False, str(e)


async def generate_weekly_digest_async() -> Optional[str]:
    """
    Weekly-Digest ノートブックで:
    1. Deep Research を実行（-n はサブコマンドの後に指定）
    2. カスタムレポートを生成
    3. Markdown でダウンロードして返す
    """
    nb_id = NOTEBOOK_IDS_FIXED["weekly_digest"]

    # 週番号からクエリを選択
    _, week = _weekly_label()
    week_num = int(week[1:])
    query = WEEKLY_RESEARCH_QUERIES[week_num % len(WEEKLY_RESEARCH_QUERIES)]

    # 1. Deep Research
    # 正しい引数順序: notebooklm source add-research <query> -n <id> --mode deep
    logger.info(f"[NotebookLM] Deep Research: {query}")
    ok, out = _run_cli([
        "source", "add-research", query,
        "-n", nb_id,
        "--mode", "deep",
        "--import-all",
    ], timeout=360)
    if not ok:
        logger.warning(f"[NotebookLM] research may have timed out (continuing): {out[:100]}")

    # 2. レポート生成
    # 正しい引数順序: notebooklm generate report <description> -n <id> --format custom --wait
    logger.info("[NotebookLM] generating weekly report...")
    ok, out = _run_cli([
        "generate", "report", WEEKLY_REPORT_PROMPT,
        "-n", nb_id,
        "--format", "custom",
        "--wait",
    ], timeout=300)
    if not ok:
        logger.error(f"[NotebookLM] report generation failed: {out[:200]}")
        return None

    # 3. レポートをダウンロード
    # 正しい引数順序: notebooklm download report <path> -n <id> --latest --force
    with tempfile.NamedTemporaryFile(
        suffix=".md", delete=False, mode="w", encoding="utf-8"
    ) as f:
        tmp_path = f.name

    ok, out = _run_cli([
        "download", "report", tmp_path,
        "-n", nb_id,
        "--latest",
        "--force",
    ], timeout=60)
    if not ok:
        logger.error(f"[NotebookLM] report download failed: {out[:200]}")
        return None

    try:
        with open(tmp_path, "r", encoding="utf-8") as f:
            report_md = f.read()
        os.unlink(tmp_path)
        logger.info(f"[NotebookLM] report generated ({len(report_md)} chars)")
        return report_md
    except Exception as e:
        logger.error(f"[NotebookLM] report read failed: {e}")
        return None


def generate_weekly_digest() -> Optional[str]:
    return asyncio.run(generate_weekly_digest_async())


# ------------------------------------------------------------------ #
#  認証チェック
# ------------------------------------------------------------------ #

async def check_auth_async() -> bool:
    try:
        async with await _make_client() as client:
            notebooks = await client.notebooks.list()
            logger.info(f"[NotebookLM] auth OK ({len(notebooks)} notebooks)")
            return True
    except Exception as e:
        logger.error(f"[NotebookLM] auth FAILED: {e}")
        return False


def check_auth() -> bool:
    return asyncio.run(check_auth_async())
