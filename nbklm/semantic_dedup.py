"""
意味での重複判定 — IMPROVEMENT_PLAN_2026-10.md S2

URLのSHA256(seen_urls.py)では別URLの「同じ話題の記事」(転載・同一論文のarXiv版とDOI版・
翌日の続報など)を見分けられない。タイトルの類似度が高い記事を1グループにまとめ、
**代表1本だけ**をNotebookLMへ追加する(レポートで同じ話が重複するのを防ぐ)。

実装は埋め込みモデルを使わない軽量版: タイトルを「英単語 + 日本語の文字2-gram」の袋にして
コサイン類似度を取る(標準ライブラリのみ。CIに重い依存を入れない)。精度が足りなければ、
`similarity()` を埋め込みの類似度に差し替えればよい(group_near_duplicates の呼び出し側は変わらない)。

閾値は「別の話題を誤って統合しない」ことを優先して高めに置く(実データでの調整結果は
IMPROVEMENT_PLAN_2026-10.md に記録)。環境変数 SEMANTIC_DEDUP=0 で無効化、
SEMANTIC_DEDUP_THRESHOLD で閾値を変更できる。

【実データで分かった誤統合パターンと対策】
- 連載(「その1」「その2」「第4回」)やバージョン違い(6.1 / 6.2)は、数字1桁しか違わず類似度が1.0近くなる
  → 数字列が一致しないタイトル同士は、類似度に関わらず重複扱いしない(_numbers_differ)。
- 「Cloudflare One Client for macOS / Windows / Linux」のようなOS別の別記事が0.94になる
  → 閾値を 0.95 に置いた。転載(ZennとQiitaの同一記事など)は 1.0 近くになるため拾える。
"""

import math
import os
import re
import unicodedata
from collections import Counter

DEFAULT_THRESHOLD = 0.95
# これより短い(正規化後の)タイトルは類似度が不安定なので、完全一致のときだけ重複とみなす
MIN_TITLE_LEN = 8

# 代表に選ぶ優先順(小さいほど優先)。公式の一次情報 > 論文 > 個人記事。
_PLATFORM_RANK = {
    "unity_blog": 0, "unity_release": 0, "ue_blog": 0, "sidefx_changelog": 0,
    "cloudflare_changelog": 0, "huggingface_blog": 0,
    "arxiv": 1, "semantic_scholar": 2,
    "cedil": 3, "cedec_youtube": 3,
    "zenn": 4, "qiita": 4,
}

_WORD_RE = re.compile(r"[a-z0-9]{2,}")
_CJK_RE = re.compile("[぀-ヿ㐀-鿿ｦ-ﾟ]+")  # ひらがな・カタカナ・漢字・半角カナ


def enabled() -> bool:
    return os.environ.get("SEMANTIC_DEDUP", "1") != "0"


def threshold() -> float:
    try:
        return float(os.environ.get("SEMANTIC_DEDUP_THRESHOLD", DEFAULT_THRESHOLD))
    except ValueError:
        return DEFAULT_THRESHOLD


def normalize(title: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", title or "").lower()).strip()


def features(title: str) -> Counter:
    """英単語(2文字以上) + 日本語の文字2-gram の出現数。"""
    text = normalize(title)
    feats: Counter = Counter(_WORD_RE.findall(text))
    for run in _CJK_RE.findall(text):
        if len(run) == 1:
            feats[run] += 1
        else:
            for i in range(len(run) - 1):
                feats[run[i:i + 2]] += 1
    return feats


def _norm(feats: Counter) -> float:
    return math.sqrt(sum(v * v for v in feats.values()))


def similarity(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(k, 0) for k, v in a.items())
    na, nb = _norm(a), _norm(b)
    return dot / (na * nb) if na and nb else 0.0


_NUM_RE = re.compile(r"\d+(?:\.\d+)*")


def _numbers_differ(norm_a: str, norm_b: str) -> bool:
    """タイトルに含まれる数字列(連載番号・バージョン・年月日)が一致しなければ True。"""
    return sorted(_NUM_RE.findall(norm_a)) != sorted(_NUM_RE.findall(norm_b))


def _rank(article: dict) -> int:
    return _PLATFORM_RANK.get(article.get("platform", ""), 5)


def group_near_duplicates(
    articles: list[dict],
    recent: list[dict] | None = None,
    thr: float | None = None,
) -> tuple[list[dict], list[dict]]:
    """
    Parameters
    ----------
    articles : これから追加する新規記事(url/title/platform を持つ dict)
    recent   : 既に追加済みの記事の記録(title/url/status)。status が "added" のものだけ比較対象
    thr      : 類似度の閾値(省略時は環境変数 or 既定値)

    Returns
    -------
    (keep, merged)
      keep   : 追加する代表記事のリスト(入力順を保つ)
      merged : 統合された記事のリスト。各要素に "merged_into"(代表のURL)と "similarity" を付与
    """
    thr = threshold() if thr is None else thr

    # 既存の追加済み記事(比較対象)
    pool: list[tuple[Counter, float, str, str]] = []  # (feats, norm, normalized_title, url)
    for r in recent or []:
        if r.get("status") != "added":
            continue
        f = features(r.get("title", ""))
        pool.append((f, _norm(f), normalize(r.get("title", "")), r.get("url", "")))

    # 代表選択を安定させるため、優先順位(公式 > 論文 > 個人記事)→入力順で処理する
    order = sorted(range(len(articles)), key=lambda i: (_rank(articles[i]), i))

    keep_idx: set[int] = set()
    merged_map: dict[int, tuple[str, float]] = {}
    kept_feats: list[tuple[int, Counter, float, str]] = []  # (idx, feats, norm, normalized_title)

    for i in order:
        a = articles[i]
        f = features(a.get("title", ""))
        n = _norm(f)
        nt = normalize(a.get("title", ""))
        best_sim, best_url = 0.0, ""

        def consider(pf, pn, pnt, purl):
            nonlocal best_sim, best_url
            if not f or not pf or not n or not pn:
                return
            if len(nt) < MIN_TITLE_LEN or len(pnt) < MIN_TITLE_LEN:
                s = 1.0 if (nt and nt == pnt) else 0.0
            elif _numbers_differ(nt, pnt):
                s = 0.0
            else:
                s = similarity(f, pf)
            if s > best_sim:
                best_sim, best_url = s, purl

        for pf, pn, pnt, purl in pool:
            consider(pf, pn, pnt, purl)
        for ki, kf, kn, knt in kept_feats:
            consider(kf, kn, knt, articles[ki].get("url", ""))

        if best_sim >= thr:
            merged_map[i] = (best_url, round(best_sim, 3))
        else:
            keep_idx.add(i)
            kept_feats.append((i, f, n, nt))

    keep = [a for i, a in enumerate(articles) if i in keep_idx]
    merged = []
    for i, a in enumerate(articles):
        if i in merged_map:
            url, sim = merged_map[i]
            merged.append({**a, "merged_into": url, "similarity": sim})
    return keep, merged
