"""
記事の分類(補助) — IMPROVEMENT_PLAN_2026-10.md S1

「選択問題」として扱う: 入力は記事タイトル(+あれば要約)、選択肢は3カテゴリ + 「どれでもない」。
どれにも当てはまらない記事は NONE_LABEL を返し、**人の確認に回す**(health.json / 収集結果ビューの
「未分類」)。

実際のノートブック振り分け(source_type → カテゴリ, nbklm/notebook_ids.py)は変更しない。
この分類は「振り分けが妥当か」を確かめる補助であり、確定判断ではない。

実装はキーワード方式(外部モデル・追加依存なし)。公式の分類モデルは英語が最高精度で、日本語は
自データで検証するよう案内されているため、日本語記事の精度は `agreement_report()` で自データから測る。
モデル方式に置き換える場合も、classify() の入出力を保てば差し替えできる。
"""

import re
from typing import Optional

CATEGORIES = ("game_dev_tech", "graphics_research", "software_engineering")
NONE_LABEL = "none"

# 1回でも当たれば採用するため、判定は「ヒットの重み合計」。weight 2 は強い手がかり。
# 英字は単語境界で、日本語は部分一致で照合する。
_KEYWORDS: dict[str, list[tuple[str, int]]] = {
    "game_dev_tech": [
        ("unity", 2), ("unreal", 2), ("ue5", 2), ("ue4", 2), ("godot", 2), ("vrchat", 2),
        ("udon", 2), ("gamedev", 2), ("game dev", 2), ("gameplay", 1), ("blueprint", 1),
        ("ecs", 1), ("dots", 1), ("netcode", 1), ("npc", 1), ("エンジン", 1),
        ("ゲーム", 2), ("ブループリント", 1), ("プレイヤー", 1), ("マルチプレイ", 1),
        ("steam", 1), ("インディー", 1), ("カメラ", 1), ("物理演算", 1), ("剛体", 1),
        ("バトル", 1), ("キャラ", 1), ("gaming", 1), ("playables", 1),
    ],
    "graphics_research": [
        ("rendering", 2), ("renderer", 2), ("shader", 2), ("hlsl", 2), ("glsl", 2),
        ("directx", 2), ("dx12", 2), ("vulkan", 2), ("ray tracing", 2), ("raytracing", 2),
        ("path tracing", 2), ("nanite", 2), ("lumen", 2), ("gpu", 1), ("lighting", 1),
        ("global illumination", 2), ("texture", 1), ("mesh", 1), ("vfx", 2), ("niagara", 2),
        ("gaussian splatting", 2), ("nerf", 2), ("siggraph", 2), ("procedural", 2),
        ("houdini", 2), ("pcg", 2), ("cop", 1), ("usd", 1), ("sdf", 1), ("vdb", 1),
        ("レンダリング", 2), ("シェーダ", 2), ("レイトレ", 2), ("描画", 2), ("ライティング", 1),
        ("テクスチャ", 1), ("メッシュ", 1), ("ポストプロセス", 2), ("プロシージャル", 2),
        ("グラフィクス", 2), ("グラフィックス", 2), ("可視化", 1), ("rendergraph", 2),
        ("3dcg", 2), ("立体視", 1), ("深度", 1),
    ],
    "software_engineering": [
        ("llm", 2), ("rag", 2), ("mcp", 2), ("agent", 1), ("embedding", 2), ("transformer", 1),
        ("machine learning", 1), ("deep learning", 1), ("inference", 1), ("benchmark", 1),
        ("api", 1), ("sdk", 1), ("architecture", 1), ("testing", 1), ("ci/cd", 2),
        ("github", 1), ("docker", 1), ("kubernetes", 1), ("cloudflare", 2), ("workers", 1),
        ("durable objects", 2), ("database", 1), ("sql", 1), ("python", 1), ("rust", 1),
        ("typescript", 1), ("security", 1), ("documentation", 2), ("tutorial", 1),
        ("software", 1), ("open source", 1), ("developer", 1), ("model", 1), ("speech", 1),
        ("エージェント", 2), ("アーキテクチャ", 1), ("セキュリティ", 1), ("ドキュメント", 2),
        ("ソフトウェア", 2), ("設計", 1), ("テスト", 1), ("開発者", 1), ("生成ai", 2),
        ("機械学習", 1), ("深層学習", 1), ("大規模言語モデル", 2), ("論文", 1), ("チュートリアル", 1),
    ],
}


def _compile(kw: str) -> re.Pattern:
    """
    5文字以上の英字語は部分一致(複数形・派生語・CEDECの「2026ENGVAUnreal」のような連結に対応)。
    4文字以下の短い語は誤爆(例: "api" が "capital" に当たる)を避けるため単語境界で照合し、複数形の s だけ許す。
    """
    if kw.isascii():
        if len(kw) >= 5:
            return re.compile(re.escape(kw))
        return re.compile(r"(?<![a-z0-9])" + re.escape(kw) + r"s?(?![a-z0-9])")
    return re.compile(re.escape(kw))


_PATTERNS = {
    cat: [(_compile(kw), w, kw) for kw, w in kws] for cat, kws in _KEYWORDS.items()
}

# これ未満しか当たらなければ「どれでもない」(人に回す)
MIN_SCORE = 1

# 話題がタグ・公式ソースで既に絞られている収集元は、タイトルに手がかり語が無くても
# その話題に属すると見なす弱い事前情報(Unityタグの記事に「Unity」と書かれているとは限らないため)。
# 出典が汎用のもの(cedec / arxiv / paper / x_post)は事前情報なし = タイトルだけで判断する。
_SOURCE_PRIOR: dict[str, tuple[str, int]] = {
    "unity":      ("game_dev_tech", 1),
    "unreal":     ("game_dev_tech", 1),
    "houdini":    ("graphics_research", 2),
    "cloudflare": ("software_engineering", 2),
    "model":      ("software_engineering", 1),
}


def classify(title: str, summary: str = "", source_type: str = "") -> dict:
    """
    Returns
    -------
    {"label": カテゴリ名 | "none", "confidence": 0〜1, "keywords": [当たった語(最大3)], "scores": {...}}
    """
    text = f"{title or ''} {summary or ''}".lower()
    scores: dict[str, int] = {}
    hits: dict[str, list[str]] = {}
    for cat, pats in _PATTERNS.items():
        total, matched = 0, []
        for pat, weight, kw in pats:
            if pat.search(text):
                total += weight
                matched.append(kw)
        scores[cat] = total
        hits[cat] = matched

    prior = _SOURCE_PRIOR.get(source_type)
    if prior:
        cat, weight = prior
        scores[cat] += weight
        hits[cat].append(f"source:{source_type}")

    best = max(CATEGORIES, key=lambda c: scores[c])
    best_score = scores[best]
    if best_score < MIN_SCORE:
        return {"label": NONE_LABEL, "confidence": 0.0, "keywords": [], "scores": scores}

    total_all = sum(scores.values())
    # 同点首位が複数 = どれか決めきれない。確信度を下げて返す(ラベルは優先順位で決定)
    tied = [c for c in CATEGORIES if scores[c] == best_score]
    confidence = best_score / total_all if total_all else 0.0
    if len(tied) > 1:
        confidence = min(confidence, 0.5)
    return {
        "label": best,
        "confidence": round(confidence, 2),
        "keywords": hits[best][:3],
        "scores": scores,
    }


def agreement_report(items: list[dict], routing: dict[str, list[str]]) -> dict:
    """
    自データでの精度確認用。items は {"title", "source_type"} のリスト、routing は
    SOURCE_TYPE_TO_CATEGORIES。現行の振り分け(source_type由来)を「正」として、
    分類結果がその範囲に収まる割合と「どれでもない」の割合を返す。
    """
    total = agree = none = 0
    for it in items:
        total += 1
        res = classify(it.get("title", ""), it.get("summary", ""), it.get("source_type", ""))
        if res["label"] == NONE_LABEL:
            none += 1
        elif res["label"] in routing.get(it.get("source_type", ""), []):
            agree += 1
    return {
        "total": total,
        "agree": agree,
        "none": none,
        "disagree": total - agree - none,
        "agree_rate": round(agree / total, 3) if total else None,
        "none_rate": round(none / total, 3) if total else None,
    }


def agrees_with_routing(label: str, routed: list[str]) -> Optional[bool]:
    """分類結果が実際の振り分け先に含まれるか。分類不能(none)なら None。"""
    if label == NONE_LABEL:
        return None
    return label in routed
