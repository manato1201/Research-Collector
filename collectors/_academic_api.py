"""
学術系API共通ヘルパー（arXiv / Semantic Scholar）
paper_collector.py と、ローカル限定の新分野コレクター
（botany/pharmacology/mineralogy, IMPROVEMENT_PLAN.md Phase 6）で
重複していたarXiv XML解析・Semantic Scholar JSON整形ロジックを共通化したもの。
ドメイン固有のクエリ・source_type/platform分類は呼び出し側が持つ。

このファイル自体はドメイン固有情報を含まないためgitignore対象ではない。
"""

import hashlib
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from .retry import retry

logger = logging.getLogger(__name__)

ARXIV_API = "https://export.arxiv.org/api/query"
SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search"

_USER_AGENT = "research-collector/1.0 (academic collector bot)"


def url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


@retry(times=3, base_delay=2.0)
def fetch_json(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---- Semantic Scholar: レート制限(HTTP 429)への対応 ---------------------------------
# APIキー無しの利用は、全利用者で共有の枠に入るため 429 が出やすい(直近の実行で7クエリが失敗した)。
#  - 呼び出しの間隔を空ける(S2_MIN_INTERVAL)
#  - 429 / 5xx は Retry-After(無ければ 5・10・20・40 秒)だけ待って再試行する
#  - 環境変数 SEMANTIC_SCHOLAR_API_KEY(無料で申請できる)があれば x-api-key で送る
#  - 429 が続いたときは、残りのクエリを打ち切る(S2RateLimited。呼び出し側で扱う)
S2_API_KEY_ENV = "SEMANTIC_SCHOLAR_API_KEY"
S2_MIN_INTERVAL = 1.2
S2_MAX_ATTEMPTS = 5
S2_MAX_DELAY = 60.0
S2_GIVE_UP_AFTER = 3  # 再試行を使い切った失敗が、この回数だけ続いたら打ち切る

_s2_last_call = 0.0


class S2RateLimited(Exception):
    """レート制限が続いて、再試行を使い切った。"""


def _retry_delay(err: "urllib.error.HTTPError", attempt: int) -> float:
    ra = err.headers.get("Retry-After") if getattr(err, "headers", None) else None
    try:
        if ra is not None:
            return min(S2_MAX_DELAY, max(1.0, float(ra)))
    except (TypeError, ValueError):
        pass
    return min(S2_MAX_DELAY, 5.0 * (2 ** (attempt - 1)))


def fetch_json_s2(url: str, timeout: int = 20) -> dict:
    """Semantic Scholar 用の取得。429 / 5xx は待って再試行し、使い切ったら S2RateLimited(429のとき)を送出する。"""
    global _s2_last_call
    headers = {"User-Agent": _USER_AGENT}
    key = os.environ.get(S2_API_KEY_ENV, "").strip()
    if key:
        headers["x-api-key"] = key

    last_err: Exception | None = None
    for attempt in range(1, S2_MAX_ATTEMPTS + 1):
        wait = S2_MIN_INTERVAL - (time.monotonic() - _s2_last_call)
        if wait > 0:
            time.sleep(wait)
        _s2_last_call = time.monotonic()
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < S2_MAX_ATTEMPTS:
                delay = _retry_delay(e, attempt)
                logger.warning(f"[S2] HTTP {e.code} (attempt {attempt}/{S2_MAX_ATTEMPTS}) — retrying in {delay:.0f}s")
                time.sleep(delay)
                continue
            if e.code == 429:
                raise S2RateLimited(f"HTTP 429 after {attempt} attempts") from e
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            if attempt < S2_MAX_ATTEMPTS:
                delay = min(S2_MAX_DELAY, 2.0 * (2 ** (attempt - 1)))
                logger.warning(f"[S2] {e} (attempt {attempt}/{S2_MAX_ATTEMPTS}) — retrying in {delay:.0f}s")
                time.sleep(delay)
                continue
            raise
    raise last_err or RuntimeError("fetch_json_s2 failed")


@retry(times=3, base_delay=2.0)
def fetch_xml(url: str, timeout: int = 15) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def parse_arxiv_xml(xml_text: str) -> list[dict]:
    """arXiv APIのAtom XMLをパースして論文リストを返す（外部ライブラリ不使用）"""
    papers = []
    entries = re.findall(r"<entry>(.*?)</entry>", xml_text, re.DOTALL)
    for entry in entries:
        def extract(tag):
            m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", entry, re.DOTALL)
            return m.group(1).strip() if m else ""

        url = extract("id").strip()
        title = re.sub(r"\s+", " ", extract("title"))

        published_str = extract("published")
        published_at = None
        if published_str:
            try:
                published_at = datetime.strptime(
                    published_str[:10], "%Y-%m-%d"
                ).replace(tzinfo=timezone.utc)
            except Exception:
                pass

        authors = re.findall(r"<name>(.*?)</name>", entry)
        author_str = ", ".join(authors[:3])
        if len(authors) > 3:
            author_str += " et al."

        if url and title:
            papers.append({
                "url": url, "title": title,
                "authors": author_str, "published_at": published_at,
            })
    return papers


def arxiv_search(
    queries: list[str],
    source_type: str,
    platform: str = "arxiv",
    max_per_query: int = 5,
) -> list[dict]:
    """クエリ群でarXivを検索し、6キースキーマ(url/title/source_type/platform/published_at/url_hash)で返す"""
    articles = []
    seen = set()

    for query in queries:
        params = urllib.parse.urlencode({
            "search_query": f"all:{query}",
            "start":        0,
            "max_results":  max_per_query,
            "sortBy":       "relevance",
            "sortOrder":    "descending",
        })
        url = f"{ARXIV_API}?{params}"
        try:
            xml_text = fetch_xml(url)
        except Exception as e:
            logger.warning(f"[arXiv:{source_type}] fetch failed: {url[:80]} → {e}")
            continue

        papers = parse_arxiv_xml(xml_text)
        logger.info(f"[arXiv:{source_type}] '{query[:40]}': {len(papers)} papers")

        for paper in papers:
            h = url_hash(paper["url"])
            if h in seen:
                continue
            seen.add(h)
            articles.append({
                "url":          paper["url"],
                "title":        paper["title"],
                "source_type":  source_type,
                "platform":     platform,
                "published_at": paper["published_at"],
                "url_hash":     h,
                "authors":      paper.get("authors", ""),
            })

        time.sleep(3)  # arXiv APIのレート制限対策

    return articles


def arxiv_search_backfill(
    queries: list[str],
    source_type: str,
    since: datetime,
    until: datetime,
    platform: str = "arxiv",
    max_per_query: int = 50,
) -> list[dict]:
    """
    since〜untilの期間でarXivを検索する（真のバックフィル）。

    arXiv APIの `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]` フィールドで
    サーバー側に日付範囲を指定する。検証の結果、この日付フィルタは検索語を
    `all:"..."` とダブルクォートで囲んだ場合のみ効くが、クォートすると
    フレーズの厳密一致（語順・隣接まで一致必須）になり、複数単語クエリ
    （例: "plant biology genomics"）ではヒット数がほぼゼロになることを
    実機確認した。そのため単語ごとに `all:word AND all:word ...` と分解して
    AND連結し、フレーズ厳密一致を避けつつ日付フィルタだけ効かせる。
    """
    articles = []
    seen = set()
    page_size = 50
    since_str = since.strftime("%Y%m%d%H%M")
    until_str = until.strftime("%Y%m%d%H%M")

    for query in queries:
        term_query = " AND ".join(f"all:{term}" for term in query.split())
        search_query = (
            f"({term_query} AND submittedDate:[{since_str} TO {until_str}])"
        )
        start = 0
        fetched = 0
        while fetched < max_per_query:
            remaining = max_per_query - fetched
            page_limit = min(page_size, remaining)
            params = urllib.parse.urlencode({
                "search_query": search_query,
                "start":        start,
                "max_results":  page_limit,
                "sortBy":       "submittedDate",
                "sortOrder":    "descending",
            })
            url = f"{ARXIV_API}?{params}"
            try:
                xml_text = fetch_xml(url)
            except Exception as e:
                logger.warning(
                    f"[arXiv:{source_type} backfill] fetch failed: {url[:80]} → {e}"
                )
                break

            papers = parse_arxiv_xml(xml_text)
            if not papers:
                break

            for paper in papers:
                h = url_hash(paper["url"])
                if h in seen:
                    continue
                seen.add(h)
                articles.append({
                    "url":          paper["url"],
                    "title":        paper["title"],
                    "source_type":  source_type,
                    "platform":     platform,
                    "published_at": paper["published_at"],
                    "url_hash":     h,
                    "authors":      paper.get("authors", ""),
                })

            fetched += len(papers)
            start += len(papers)
            time.sleep(3)

            if len(papers) < page_limit:
                break

    return articles


def _s2_paper_to_article(
    paper: dict, source_type: str, platform: str
) -> Optional[dict]:
    paper_url = None
    ext_ids = paper.get("externalIds", {}) or {}

    if ext_ids.get("DOI"):
        paper_url = f"https://doi.org/{ext_ids['DOI']}"
    elif paper.get("openAccessPdf"):
        paper_url = paper["openAccessPdf"].get("url")
    elif paper.get("paperId"):
        paper_url = f"https://www.semanticscholar.org/paper/{paper['paperId']}"

    if not paper_url:
        return None

    authors_list = paper.get("authors", []) or []
    author_str = ", ".join(a.get("name", "") for a in authors_list[:3])
    if len(authors_list) > 3:
        author_str += " et al."

    published_at = None
    pub_date_str = paper.get("publicationDate")
    if pub_date_str:
        try:
            published_at = datetime.strptime(
                pub_date_str, "%Y-%m-%d"
            ).replace(tzinfo=timezone.utc)
        except Exception:
            pass
    if published_at is None:
        year = paper.get("year")
        if year:
            try:
                published_at = datetime(int(year), 1, 1, tzinfo=timezone.utc)
            except Exception:
                pass

    return {
        "url":          paper_url,
        "title":        paper.get("title", ""),
        "source_type":  source_type,
        "platform":     platform,
        "published_at": published_at,
        "url_hash":     url_hash(paper_url),
        "authors":      author_str,
    }


def semantic_scholar_search(
    queries: list[str],
    source_type: str,
    platform: str = "semantic_scholar",
    max_per_query: int = 5,
) -> list[dict]:
    """クエリ群でSemantic Scholarを検索する（APIキー不要）"""
    articles = []
    seen = set()
    gave_up = 0  # 再試行を使い切った失敗の連続回数

    for query in queries:
        if gave_up >= S2_GIVE_UP_AFTER:
            logger.warning(f"[S2:{source_type}] rate limited — skipping the remaining queries")
            break
        params = urllib.parse.urlencode({
            "query":  query,
            "limit":  max_per_query,
            "fields": "title,authors,year,externalIds,openAccessPdf,url",
        })
        url = f"{SEMANTIC_SCHOLAR_API}?{params}"
        try:
            data = fetch_json_s2(url)
            gave_up = 0
        except Exception as e:
            logger.warning(f"[S2:{source_type}] fetch failed: {url[:80]} → {e}")
            gave_up = gave_up + 1 if isinstance(e, S2RateLimited) else 0
            continue

        papers = data.get("data", []) or []
        logger.info(f"[S2:{source_type}] '{query[:40]}': {len(papers)} papers")

        for paper in papers:
            article = _s2_paper_to_article(paper, source_type, platform)
            if not article or article["url_hash"] in seen:
                continue
            seen.add(article["url_hash"])
            articles.append(article)

        time.sleep(1)  # レート制限対策

    return articles


def semantic_scholar_search_backfill(
    queries: list[str],
    source_type: str,
    since: datetime,
    until: datetime,
    platform: str = "semantic_scholar",
    max_per_query: int = 50,
) -> list[dict]:
    """since〜untilの期間でSemantic Scholarを検索する（真のバックフィル）"""
    articles = []
    seen = set()
    date_range = f"{since.strftime('%Y-%m-%d')}:{until.strftime('%Y-%m-%d')}"

    for query in queries:
        params = urllib.parse.urlencode({
            "query":                 query,
            "limit":                 max_per_query,
            "fields":                "title,authors,year,externalIds,openAccessPdf,url,publicationDate",
            "publicationDateOrYear": date_range,
        })
        url = f"{SEMANTIC_SCHOLAR_API}?{params}"
        try:
            data = fetch_json(url)
        except Exception as e:
            logger.warning(f"[S2:{source_type} backfill] fetch failed: {url[:80]} → {e}")
            continue

        papers = data.get("data", []) or []
        for paper in papers:
            article = _s2_paper_to_article(paper, source_type, platform)
            if not article or article["url_hash"] in seen:
                continue
            seen.add(article["url_hash"])
            articles.append(article)

        time.sleep(1)

    return articles
