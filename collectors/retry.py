"""
共通リトライユーティリティ
ネットワーク取得系の関数に指数バックオフ付きリトライを付与する。
"""

import functools
import logging
import time

logger = logging.getLogger(__name__)

# 取得失敗の記録(health.json の source_failures に載せる)。
# 各collectorは失敗を握りつぶして処理を継続する設計のため、失敗がログにしか残らなかった。
_FAILURES: list[dict] = []


def record_failure(source: str, error: Exception | str) -> None:
    """取得失敗を1件記録する。source は短い識別名(フィードURLのホスト等)。"""
    _FAILURES.append({"source": source, "error": str(error)[:160]})


def pop_failures() -> list[dict]:
    """記録済みの失敗を返して空にする。"""
    items = list(_FAILURES)
    _FAILURES.clear()
    return items


def retry(times: int = 3, base_delay: float = 2.0):
    """
    デコレートした関数が例外を送出した場合、指数バックオフで最大times回リトライする。
    全て失敗した場合は最後の例外をそのまま送出する(呼び出し元の既存のエラー処理に委ねる)。
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last_exc = None
            for attempt in range(1, times + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exc = e
                    if attempt < times:
                        delay = base_delay * (2 ** (attempt - 1))
                        logger.warning(
                            f"{func.__name__} failed (attempt {attempt}/{times}): "
                            f"{e} — retrying in {delay:.0f}s"
                        )
                        time.sleep(delay)
            raise last_exc
        return wrapper
    return decorator


@retry(times=3, base_delay=2.0)
def fetch_feed(url: str):
    """
    feedparserでURLを取得する。
    feedparserはHTTPエラー時も例外を送出せずbozo=1・entries空の
    フィードを返すことがあるため、その場合は例外化してリトライ対象にする。
    """
    import feedparser
    feed = feedparser.parse(url)
    if feed.bozo and not feed.entries:
        raise feed.bozo_exception or RuntimeError(f"feed parse failed: {url}")
    return feed
