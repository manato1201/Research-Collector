"""
notebooklm-py ラッパー
週次ノートブック自動作成・重複チェック対応版
Weekly Digest: 当週の収集ノートブックを参照してレポート生成（日本語）
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


async def _get_weekly_notebook_ids(
    client: NotebookLMClient, year: str, week: str
) -> dict[str, str]:
    """当週の全カテゴリのノートブックIDを返す（存在するものだけ）"""
    categories = ["game_dev_tech", "graphics_research", "software_engineering"]
    result = {}
    notebooks = await client.notebooks.list()
    nb_map = {nb.title: nb.id for nb in notebooks}

    for category in categories:
        name = _weekly_name(category, year, week)
        if name in nb_map:
            result[category] = nb_map[name]
            logger.info(f"[NotebookLM] digest source: {name}")
        else:
            logger.warning(f"[NotebookLM] not found: {name} (skipping)")

    return result


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
#  週次 Digest 生成
#  当週の収集ノートブック3つを参照してカテゴリ別レポートを生成
# ------------------------------------------------------------------ #

REPORT_PROMPTS = {
    "game_dev_tech": (
        "必ず日本語で出力してください。英語での出力は不可です。\n\n"
        "このノートブックに蓄積された今週の技術記事をもとに、"
        "ゲーム開発・エンジン技術の週次まとめレポートを作成してください。\n\n"
        "## フォーマット（必ず守ること）\n"
        "### 1. 今週の注目トピック（3点）\n"
        "### 2. Unity 最新動向\n"
        "### 3. Unreal Engine 最新動向\n"
        "### 4. 注目記事リスト（タイトルと1〜2行の要約）\n\n"
        "対象読者: ゲームエンジン・ツールエンジニアを目指す学生\n"
        "トーン: 技術的・簡潔・重要度順"
    ),
    "graphics_research": (
        "必ず日本語で出力してください。英語での出力は不可です。\n\n"
        "このノートブックに蓄積された今週の技術記事をもとに、"
        "グラフィクス・レンダリング技術の週次まとめレポートを作成してください。\n\n"
        "## フォーマット（必ず守ること）\n"
        "### 1. 今週の注目トピック（3点）\n"
        "### 2. レンダリング技術の動向\n"
        "### 3. DirectX12 / HLSL 関連\n"
        "### 4. CEDEC / GDC 注目資料\n\n"
        "対象読者: ゲームエンジン・ツールエンジニアを目指す学生\n"
        "トーン: 技術的・簡潔・重要度順"
    ),
    "software_engineering": (
        "必ず日本語で出力してください。英語での出力は不可です。\n\n"
        "このノートブックに蓄積された今週の論文・技術資料をもとに、"
        "ソフトウェア工学・CG論文の週次まとめレポートを作成してください。\n\n"
        "## フォーマット（必ず守ること）\n"
        "### 1. 今週の注目論文（3点）\n"
        "### 2. RAG・LLM 関連研究\n"
        "### 3. DCCツール学習・ドキュメント関連研究\n"
        "### 4. その他注目研究\n"
        "### 5. 卒論テーマとの関連\n"
        "（テーマ: RAGとMCPを用いたHoudiniチュートリアル自動生成システム）\n\n"
        "対象読者: ゲームエンジン・ツールエンジニアを目指す学生\n"
        "トーン: 技術的・簡潔・重要度順"
    ),
}

CATEGORY_LABELS = {
    "game_dev_tech":        "## 🎮 ゲーム開発・エンジン技術",
    "graphics_research":    "## 🖥️ グラフィクス・レンダリング技術",
    "software_engineering": "## 📄 ソフトウェア工学・論文",
}


def _run_cli(args: list[str], timeout: int = 300) -> tuple[bool, str]:
    """notebooklm CLI をサブプロセスで実行する"""
    try:
        result = subprocess.run(
            ["notebooklm"] + args,
            capture_output=True,
            text=True,
            env=os.environ.copy(),
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


def _set_language_ja() -> bool:
    """NotebookLMの出力言語を日本語に設定する"""
    ok, out = _run_cli(["language", "set", "ja", "--local"], timeout=30)
    if ok:
        logger.info("[NotebookLM] language set to ja")
    else:
        logger.warning(f"[NotebookLM] language set failed: {out[:100]}")
    return ok


def _generate_report_for_notebook(nb_id: str, category: str) -> Optional[str]:
    """指定ノートブックに対してレポートを生成してMarkdown文字列で返す"""
    prompt = REPORT_PROMPTS.get(category, "")

    # レポート生成（--language ja を明示指定）
    ok, out = _run_cli([
        "generate", "report", prompt,
        "-n", nb_id,
        "--format", "custom",
        "--language", "ja",
        "--wait",
    ], timeout=300)

    if not ok:
        logger.error(f"[NotebookLM] report failed for {category}: {out[:200]}")
        return None

    # ダウンロード
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
        logger.error(f"[NotebookLM] download failed for {category}: {out[:200]}")
        return None

    try:
        with open(tmp_path, "r", encoding="utf-8") as f:
            content = f.read()
        os.unlink(tmp_path)
        logger.info(f"[NotebookLM] {category} report: {len(content)} chars")
        return content
    except Exception as e:
        logger.error(f"[NotebookLM] read failed for {category}: {e}")
        return None


async def generate_weekly_digest_async() -> Optional[str]:
    """
    当週の3つの収集ノートブックを参照してカテゴリ別レポートを生成し、
    1本の日本語Markdownにまとめて返す。
    """
    year, week = _weekly_label()

    # 出力言語を日本語に設定
    _set_language_ja()

    # 当週ノートブックのIDを取得
    async with await _make_client() as client:
        nb_ids = await _get_weekly_notebook_ids(client, year, week)

    if not nb_ids:
        logger.error("[NotebookLM] no weekly notebooks found for this week")
        return None

    logger.info(f"[NotebookLM] generating digest from {len(nb_ids)} notebooks")

    # カテゴリ別にレポートを生成してまとめる
    date_str = datetime.now().strftime("%Y-%m-%d")
    sections = [
        f"# 週次リサーチダイジェスト — {year}-{week}（{date_str}）\n",
        "> **収集ノートブック:** "
        + "、".join(_weekly_name(c, year, week) for c in nb_ids)
        + "\n",
        "> **生成日時:** " + datetime.now().strftime("%Y年%m月%d日 %H:%M") + "\n",
    ]

    for category, nb_id in nb_ids.items():
        label = CATEGORY_LABELS.get(category, f"## {category}")
        nb_name = _weekly_name(category, year, week)
        logger.info(f"[NotebookLM] generating report: {nb_name}")

        report = _generate_report_for_notebook(nb_id, category)
        if report:
            sections.append(f"\n{label}\n")
            sections.append(report)
        else:
            sections.append(f"\n{label}\n")
            sections.append(f"> ⚠️ {nb_name} のレポート生成に失敗しました\n")

    full_report = "\n".join(sections)
    logger.info(f"[NotebookLM] digest complete ({len(full_report)} chars total)")
    return full_report


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


# ------------------------------------------------------------------ #
#  ノートブック容量上限の自動対応
# ------------------------------------------------------------------ #

async def cleanup_notebooks_async() -> list[str]:
    from .notebook_cleanup import cleanup_oldest_notebooks_async

    async with await _make_client() as client:
        return await cleanup_oldest_notebooks_async(client)


def cleanup_notebooks() -> list[str]:
    return asyncio.run(cleanup_notebooks_async())
