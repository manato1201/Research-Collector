"""
論文コレクター
- arXiv API（無料・APIキー不要）
- Semantic Scholar API（無料・APIキー不要）

卒論「RAGとMCPを用いたDCCツール向けチュートリアル自動生成システム」
の背景・問題提起の根拠収集を主目的とする。
"""

import hashlib
import logging
import time
import urllib.parse
import urllib.request
import json
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
#  収集キーワード定義
# ------------------------------------------------------------------ #

# arXiv 検索クエリ
ARXIV_QUERIES = [
    # RAG・LLMによる学習支援（システムの有効性根拠）
    "retrieval augmented generation tutorial generation",
    "LLM step by step instruction generation",
    "conversational agent learning assistance",
    "chatbot technical documentation question answering",

    # 学習行動・ドキュメント利用（命題①②の根拠）
    "video tutorial learning behavior software",
    "developer documentation usage behavior",

    # ドキュメント陳腐化（命題③の根拠）
    "software documentation maintenance outdated",
    "tutorial obsolescence software update",
]

# Semantic Scholar 検索クエリ
SEMANTIC_SCHOLAR_QUERIES = [
    # 学習行動
    "developer documentation usage behavior",
    "video tutorial software learning",
    "how developers learn new tools",

    # ドキュメント陳腐化・技術的負債
    "tutorial maintenance technical debt",
    "software documentation outdated obsolete",

    # RAG・チュートリアル生成
    "RAG retrieval augmented generation documentation",
    "LLM tutorial generation step by step",

    # DCC・クリエイティブツール
    "DCC tool learning curve creative software",
    "Houdini procedural generation learning",
]


# ------------------------------------------------------------------ #
#  ユーティリティ
# ------------------------------------------------------------------ #

def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def _fetch_json(url: str, timeout: int = 15) -> Optional[dict]:
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "research-collector/1.0 (graduation thesis bot)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        logger.warning(f"fetch failed: {url[:80]} → {e}")
        return None


def _fetch_xml(url: str, timeout: int = 15) -> Optional[str]:
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "research-collector/1.0 (graduation thesis bot)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        logger.warning(f"fetch failed: {url[:80]} → {e}")
        return None


# ------------------------------------------------------------------ #
#  arXiv コレクター
# ------------------------------------------------------------------ #

ARXIV_API = "https://export.arxiv.org/api/query"


def _parse_arxiv_xml(xml_text: str) -> list[dict]:
    """arXiv APIのAtom XMLをパースして論文リストを返す（外部ライブラリ不使用）"""
    import re
    papers = []

    entries = re.findall(r"<entry>(.*?)</entry>", xml_text, re.DOTALL)
    for entry in entries:
        def extract(tag):
            m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", entry, re.DOTALL)
            return m.group(1).strip() if m else ""

        # URL（id）
        raw_id = extract("id")
        url = raw_id.strip()

        # タイトル
        title = re.sub(r"\s+", " ", extract("title"))

        # 公開日
        published_str = extract("published")
        published_at = None
        if published_str:
            try:
                published_at = datetime.strptime(
                    published_str[:10], "%Y-%m-%d"
                ).replace(tzinfo=timezone.utc)
            except Exception:
                pass

        # 著者
        authors = re.findall(r"<name>(.*?)</name>", entry)
        author_str = ", ".join(authors[:3])
        if len(authors) > 3:
            author_str += " et al."

        if url and title:
            papers.append({
                "url":          url,
                "title":        title,
                "authors":      author_str,
                "published_at": published_at,
            })

    return papers


def collect_arxiv(max_per_query: int = 5) -> list[dict]:
    """arXiv APIから論文を収集する"""
    articles = []
    seen_hashes = set()

    for query in ARXIV_QUERIES:
        params = urllib.parse.urlencode({
            "search_query": f"all:{query}",
            "start":        0,
            "max_results":  max_per_query,
            "sortBy":       "relevance",
            "sortOrder":    "descending",
        })
        url = f"{ARXIV_API}?{params}"

        xml_text = _fetch_xml(url)
        if not xml_text:
            continue

        papers = _parse_arxiv_xml(xml_text)
        logger.info(f"[arXiv] '{query[:40]}': {len(papers)} papers")

        for paper in papers:
            h = _url_hash(paper["url"])
            if h in seen_hashes:
                continue
            seen_hashes.add(h)

            articles.append({
                "url":          paper["url"],
                "title":        paper["title"],
                "source_type":  "arxiv",
                "platform":     "arxiv",
                "published_at": paper["published_at"],
                "url_hash":     h,
                "authors":      paper.get("authors", ""),
            })

        # arXiv APIのレート制限対策（3秒待機）
        time.sleep(3)

    logger.info(f"[arXiv] total {len(articles)} papers collected")
    return articles


# ------------------------------------------------------------------ #
#  Semantic Scholar コレクター
# ------------------------------------------------------------------ #

SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search"


def collect_semantic_scholar(max_per_query: int = 5) -> list[dict]:
    """Semantic Scholar APIから論文を収集する（APIキー不要）"""
    articles = []
    seen_hashes = set()

    for query in SEMANTIC_SCHOLAR_QUERIES:
        params = urllib.parse.urlencode({
            "query":  query,
            "limit":  max_per_query,
            "fields": "title,authors,year,externalIds,openAccessPdf,url",
        })
        url = f"{SEMANTIC_SCHOLAR_API}?{params}"

        data = _fetch_json(url)
        if not data:
            continue

        papers = data.get("data", [])
        logger.info(f"[S2] '{query[:40]}': {len(papers)} papers")

        for paper in papers:
            # URLの決定（DOI > openAccessPdf > semanticscholar）
            paper_url = None
            ext_ids = paper.get("externalIds", {}) or {}

            if ext_ids.get("DOI"):
                paper_url = f"https://doi.org/{ext_ids['DOI']}"
            elif paper.get("openAccessPdf"):
                paper_url = paper["openAccessPdf"].get("url")
            elif paper.get("paperId"):
                paper_url = (
                    f"https://www.semanticscholar.org/paper/{paper['paperId']}"
                )

            if not paper_url:
                continue

            h = _url_hash(paper_url)
            if h in seen_hashes:
                continue
            seen_hashes.add(h)

            # 著者
            authors_list = paper.get("authors", []) or []
            author_str = ", ".join(
                a.get("name", "") for a in authors_list[:3]
            )
            if len(authors_list) > 3:
                author_str += " et al."

            # 公開年 → datetime
            year = paper.get("year")
            published_at = None
            if year:
                try:
                    published_at = datetime(int(year), 1, 1, tzinfo=timezone.utc)
                except Exception:
                    pass

            articles.append({
                "url":          paper_url,
                "title":        paper.get("title", ""),
                "source_type":  "paper",
                "platform":     "semantic_scholar",
                "published_at": published_at,
                "url_hash":     h,
                "authors":      author_str,
            })

        # レート制限対策（1秒待機）
        time.sleep(1)

    logger.info(f"[S2] total {len(articles)} papers collected")
    return articles


# ------------------------------------------------------------------ #
#  まとめて収集
# ------------------------------------------------------------------ #

def collect(
    max_arxiv: int = 5,
    max_semantic: int = 5,
) -> list[dict]:
    """arXiv + Semantic Scholar をまとめて収集して返す"""
    articles = []

    articles.extend(collect_arxiv(max_per_query=max_arxiv))
    articles.extend(collect_semantic_scholar(max_per_query=max_semantic))

    # 重複除去
    seen = set()
    unique = []
    for a in articles:
        h = a["url_hash"]
        if h not in seen:
            seen.add(h)
            unique.append(a)

    logger.info(f"[paper] total {len(unique)} unique papers collected")
    return unique
