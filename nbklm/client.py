"""
notebooklm-py ラッパー
research-collector から呼び出す NotebookLM 操作をまとめたモジュール
"""

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime
from typing import Optional

from notebooklm import NotebookLMClient

from .notebook_ids import NOTEBOOK_IDS, SOURCE_TYPE_TO_NOTEBOOK

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
#  認証クライアント生成
# ------------------------------------------------------------------ #

async def _make_client() -> NotebookLMClient:
    """
    NOTEBOOKLM_AUTH_JSON 環境変数があればそれを使い、
    なければデフォルトの storage_state.json を使う。
    """
    auth_json = os.environ.get("NOTEBOOKLM_AUTH_JSON", "").strip()

    if auth_json:
        # 環境変数から一時ファイルに書き出して from_storage() に渡す
        logger.info("[NotebookLM] using NOTEBOOKLM_AUTH_JSON env var")
        try:
            # JSON として valid か確認
            json.loads(auth_json)
        except json.JSONDecodeError as e:
            raise ValueError(f"NOTEBOOKLM_AUTH_JSON is not valid JSON: {e}")

        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        )
        tmp.write(auth_json)
        tmp.flush()
        tmp.close()

        client = await NotebookLMClient.from_storage(path=tmp.name)
        return client
    else:
        logger.info("[NotebookLM] using default storage_state.json")
        return await NotebookLMClient.from_storage()


# ------------------------------------------------------------------ #
#  内部ヘルパー
# ------------------------------------------------------------------ #

def _get_notebook_id(source_type: str) -> str:
    key = SOURCE_TYPE_TO_NOTEBOOK.get(source_type, "game_dev_tech")
    return NOTEBOOK_IDS[key]


# ------------------------------------------------------------------ #
#  記事URLの一括追加
# ------------------------------------------------------------------ #

async def add_articles_to_notebooklm(articles: list[dict]) -> dict:
    result = {"ok": 0, "skip": 0, "errors": []}

    async with await _make_client() as client:
        for article in articles:
            url = article.get("url", "")
            source_type = article.get("source_type", "zenn")
            nb_id = _get_notebook_id(source_type)

            try:
                await client.sources.add_url(nb_id, url, wait=False)
                logger.info(f"[NotebookLM] added: {url[:80]}")
                result["ok"] += 1
            except Exception as e:
                msg = f"{url[:60]} → {e}"
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
    nb_id = NOTEBOOK_IDS["software_engineering"]
    async with await _make_client() as client:
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
#  週次 Digest 生成
# ------------------------------------------------------------------ #

WEEKLY_DIGEST_PROMPT = """
ゲーム開発・グラフィクス技術の週次まとめレポートを日本語で作成してください。

## 対象テーマ
- Unity / Unreal Engine の最新動向・アップデート
- DirectX 12 / HLSL / リアルタイムレンダリング技術
- ゲームエンジン・ツール開発
- ソフトウェア工学・CG論文ピックアップ

## フォーマット
1. 今週のハイライト（3点）
2. Unity / UE 注目トピック
3. グラフィクス・レンダリング技術
4. 論文・CEDEC/GDC ピックアップ
5. 来週注目すべき動向

対象読者: ゲームエンジン・ツールエンジニアを目指す学生
トーン: 技術的かつ簡潔に、重要度順で記述
"""

WEEKLY_RESEARCH_QUERIES = [
    "Unity 最新アップデート 2026",
    "Unreal Engine 新機能 2026",
    "DirectX12 HLSL リアルタイムレンダリング",
    "ゲームエンジン 技術 最新",
]


async def generate_weekly_digest_async() -> Optional[str]:
    nb_id = NOTEBOOK_IDS["weekly_digest"]

    async with await _make_client() as client:
        week_num = datetime.now().isocalendar()[1]
        query = WEEKLY_RESEARCH_QUERIES[week_num % len(WEEKLY_RESEARCH_QUERIES)]
        logger.info(f"[NotebookLM] Deep Research: {query}")

        try:
            await client.sources.add_research(
                nb_id,
                query=query,
                mode="deep",
                auto_import=True,
            )
        except Exception as e:
            logger.warning(f"[NotebookLM] research timeout (may be ok): {e}")

        logger.info("[NotebookLM] generating weekly report...")
        try:
            status = await client.artifacts.generate_report(
                nb_id,
                format="custom",
                instructions=WEEKLY_DIGEST_PROMPT,
            )
            await client.artifacts.wait_for_completion(nb_id, status.task_id)

            report_md = await client.artifacts.download_report(
                nb_id, format="markdown"
            )
            logger.info(f"[NotebookLM] report generated ({len(report_md)} chars)")
            return report_md

        except Exception as e:
            logger.error(f"[NotebookLM] report generation failed: {e}")
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