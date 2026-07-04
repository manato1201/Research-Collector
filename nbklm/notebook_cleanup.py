"""
ノートブック容量上限の自動対応
NotebookLM Plusのノートブック上限(500冊)に近づいたら、
最も古い週次ノートブックから順に削除して空きを作る。

Weekly-Digest等、週次命名規則(...-{YYYY}-W{NN})に一致しないノートブックは
保護対象として削除しない。
"""

import logging
import re

logger = logging.getLogger(__name__)

# NotebookLM Plusの上限は500冊。到達前に自動削除するための閾値(安全マージン込み)。
MAX_NOTEBOOKS = 480

_WEEKLY_TITLE_RE = re.compile(r"^.+-(\d{4})-W(\d{2})$")


def _is_deletable(notebook) -> bool:
    """自動生成された週次ノートブックのみを削除対象とする(手動作成物・固定ノートブックは保護)"""
    return bool(_WEEKLY_TITLE_RE.match(notebook.title))


def _week_key(notebook) -> tuple[int, int]:
    m = _WEEKLY_TITLE_RE.match(notebook.title)
    return (int(m.group(1)), int(m.group(2)))


async def cleanup_oldest_notebooks_async(
    client, max_notebooks: int = MAX_NOTEBOOKS
) -> list[str]:
    """
    ノートブック総数がmax_notebooksを超えていたら、最も古い週次ノートブックから
    順に削除し、超過分を解消する。削除したノートブック名のリストを返す。
    """
    notebooks = await client.notebooks.list()
    total = len(notebooks)
    if total <= max_notebooks:
        return []

    deletable = sorted(
        (nb for nb in notebooks if _is_deletable(nb)),
        key=_week_key,
    )

    to_delete_count = total - max_notebooks
    targets = deletable[:to_delete_count]

    deleted = []
    for nb in targets:
        await client.notebooks.delete(nb.id)
        logger.warning(f"[notebook_cleanup] deleted (capacity limit): {nb.title}")
        deleted.append(nb.title)

    if len(targets) < to_delete_count:
        logger.warning(
            f"[notebook_cleanup] {total}冊 中 {to_delete_count}冊分の削除が必要だが、"
            f"削除可能な週次ノートブックは{len(deletable)}冊しかなかった"
        )

    return deleted
