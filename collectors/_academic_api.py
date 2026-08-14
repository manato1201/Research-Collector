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
import re
import time
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

    for query in queries:
        params = urllib.parse.urlencode({
            "query":  query,
            "limit":  max_per_query,
            "fields": "title,authors,year,externalIds,openAccessPdf,url",
        })
        url = f"{SEMANTIC_SCHOLAR_API}?{params}"
        try:
            data = fetch_json(url)
        except Exception as e:
            logger.warning(f"[S2:{source_type}] fetch failed: {url[:80]} → {e}")
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
