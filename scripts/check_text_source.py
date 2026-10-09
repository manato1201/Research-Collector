"""
NotebookLM の「テキストソース追加」が実サービスで動くかの確認用(1回だけ手動で実行する)。

X投稿の取り込み(collectors/x_posts_collector.py)は、URLではなく本文を
`client.sources.add_text()` で追加する。この経路は、実装時に認証が切れていて実サービスでは
確認できなかったため、認証を通した状態で次のコマンドを1回実行して確かめる:

    python scripts/check_text_source.py

使い捨てのノートブックを1つ作り、テキストを1件追加し、ソース数を確認して、ノートブックを削除する。
既存のノートブック(週次ノートブックなど)には触れない。途中で失敗しても、作ったノートブックは削除を試みる。
終了コード: 0 = 成功 / 1 = 失敗
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TITLE = "zz-rc-selftest-delete-me"


async def run() -> int:
    from nbklm.client import _make_client

    async with await _make_client() as client:
        nb = await client.notebooks.create(title=TITLE)
        print(f"created throwaway notebook: {TITLE} ({nb.id[:8]}...)")
        ok = False
        try:
            await client.sources.add_text(
                nb.id,
                "selftest (text source)",
                "これはテキストソース追加の動作確認です。\n\n投稿者: selftest\n出典: https://example.com/",
                wait=False,
            )
            sources = await client.sources.list(nb.id)
            print(f"text source added; sources in notebook: {len(sources)}")
            ok = len(sources) >= 1
        except Exception as e:
            print(f"FAILED: {e}")
        finally:
            try:
                await client.notebooks.delete(nb.id)
                print("throwaway notebook deleted")
            except Exception as e:
                print(f"WARNING: could not delete the throwaway notebook ({TITLE}); delete it manually: {e}")
        return 0 if ok else 1


def main() -> None:
    try:
        sys.exit(asyncio.run(run()))
    except Exception as e:
        print(f"FAILED (auth or connection): {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
