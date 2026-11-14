# 第 1 回 意味の重複を除く(軽量な類似度)

> 所要時間の目安: 3 時間 / 前提: 第 0 回・ベクトルの内積の基本

## この回のゴール

- タイトルを**「英単語 + 日本語の 2-gram」の袋**にして、**コサイン類似度**で比べる方法を説明できる。
- **連載・バージョン違い**を誤って統合しない工夫(**数字列の一致**)を説明できる。
- **しきい値を高く置く**理由と、**代表を選ぶ優先順**(公式 > 論文 > 個人記事)を説明できる。
- 標準ライブラリだけの実装で、**あとで埋め込みモデルに差し替えられる**作りを説明できる。

## 1. 特徴: 英単語と、日本語の 2-gram

日本語は、単語の区切りが無いので、**隣り合う 2 文字(2-gram)**を特徴にします。英語は、**2 文字以上の英数字の語**。

```python
# 引用: nbklm/semantic_dedup.py::features
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
```

```python
# 実行できる
from nbklm.semantic_dedup import features, normalize

print("正規化(全角→半角・小文字・空白):", repr(normalize("Ｕｎｉｔｙ　６  の新機能")))
print(dict(features("Unity の新機能まとめ")))
```

```text
# 出力
正規化(全角→半角・小文字・空白): 'unity 6 の新機能'
{'unity': 1, 'の新': 1, '新機': 1, '機能': 1, '能ま': 1, 'まと': 1, 'とめ': 1}
```

`normalize` は **NFKC**(全角の英数を半角に、など)で、表記ゆれをそろえます。

## 2. コサイン類似度

2 つのタイトルの特徴を**ベクトル**(各特徴の出現数)とみなし、**向きの近さ**を測ります。

```text
類似度 = (a · b) / (|a| × |b|)      0(無関係)〜 1(同じ)
```

```python
# 引用: nbklm/semantic_dedup.py::similarity
def similarity(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(k, 0) for k, v in a.items())
    na, nb = _norm(a), _norm(b)
    return dot / (na * nb) if na and nb else 0.0
```

**長さに依らず、向き(話題)だけ**を見るのが利点です。小さいほうの辞書を回して、内積を計算します。

```python
# 実行できる
from nbklm.semantic_dedup import features, similarity

pairs = [
    ("転載(同じタイトル)", "Unityの新機能まとめ 2026", "Unityの新機能まとめ 2026"),
    ("少し違う", "Unity の新機能まとめ", "Unity の新機能のまとめ"),
    ("別の話題", "Unity の新機能まとめ", "Rust で作る Web サーバー入門"),
]
for label, a, b in pairs:
    print(f"{label:12} {similarity(features(a), features(b)):.2f}")
```

```text
# 出力
転載(同じタイトル)   1.00
少し違う         0.80
別の話題         0.00
```

## 3. 誤って統合しない工夫

実データで見つかった**誤統合**を、ルールで防いでいます。

| 誤統合 | 原因 | 対策 |
|---|---|---|
| 連載(「その 1」「その 2」)・バージョン違い(6.1 / 6.2) | 数字 1 つしか違わず、類似度が 1.0 近くになる | **数字列が一致しない**タイトルは、類似度に関わらず**重複としない**(`_numbers_differ`) |
| OS 別の別記事(macOS / Windows / Linux) | 0.94 近くになる | しきい値を **0.95** に置く(転載は 1.0 近くになるので拾える) |
| 短いタイトル | 類似度が不安定 | 正規化後 **8 文字未満**は、**完全一致のときだけ**重複 |
| タイトルが途中で切れる(末尾が `...` `…`) | 先頭が同じ別の変更が同一視される | 切れたときだけ、**要約の先頭 100 文字**を足して比べる |

> **思想**: 「別の話題を、誤って統合しない」ことを、**見逃しより優先**する(統合すると、読むべき記事が消える。見逃しは、重複が少し残るだけ)。

## 4. 代表を選ぶ

同じ話題の記事が複数あるとき、**1 本だけ**残します。優先順: **公式の一次情報**(Unity・UE・Cloudflare の公式ブログなど)> **論文**(arXiv)> **個人記事**(Zenn・Qiita)。同じ優先なら、**入力の順**。

```python
# 引用: nbklm/semantic_dedup.py::group_near_duplicates
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
        text = comparison_text(r)
        f = features(text)
        pool.append((f, _norm(f), normalize(text), r.get("url", "")))

    # 代表選択を安定させるため、優先順位(公式 > 論文 > 個人記事)→入力順で処理する
    order = sorted(range(len(articles)), key=lambda i: (_rank(articles[i]), i))

    keep_idx: set[int] = set()
    merged_map: dict[int, tuple[str, float]] = {}
    kept_feats: list[tuple[int, Counter, float, str]] = []  # (idx, feats, norm, normalized_title)

    for i in order:
        a = articles[i]
        text = comparison_text(a)
        f = features(text)
        n = _norm(f)
        nt = normalize(text)
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
```

戻り値は `(keep, merged)`: `keep` は追加する代表(入力順を保つ)、`merged` は統合された記事(`merged_into` に代表の URL、`similarity` つき)。

```python
# 実行できる
from nbklm.semantic_dedup import group_near_duplicates


def art(title, url, platform="zenn", summary=""):
    return {"title": title, "url": url, "platform": platform, "summary": summary}


articles = [
    art("Unity 6.1 の新機能まとめ", "z1"),
    art("Unity 6.2 の新機能まとめ", "z2"),                       # 数字が違う = 別の記事
    art("Unityの新機能まとめ 2026", "z3", "zenn"),
    art("Unityの新機能まとめ 2026", "q1", "qiita"),               # 転載
    art("Unityの新機能まとめ 2026", "u1", "unity_blog"),          # 公式が同じタイトル
]
keep, merged = group_near_duplicates(articles)
print("残る:", [(a["url"], a["platform"]) for a in keep])
for m in merged:
    print("統合:", m["url"], "→", m["merged_into"], f"(類似度 {m['similarity']:.2f})")
```

```text
# 出力
残る: [('z1', 'zenn'), ('z2', 'zenn'), ('u1', 'unity_blog')]
統合: z3 → u1 (類似度 1.00)
統合: q1 → u1 (類似度 1.00)
```

「公式(`u1`)」が優先され、同じ話題の個人記事(`z3`・`q1`)は、公式に**統合**されます。6.1 と 6.2 は、数字が違うので、**別の記事**のままです。

## 5. あとで差し替えられる

実装は、**埋め込みモデルを使わない**(標準ライブラリだけ)ので、CI に重い依存が入りません。精度が足りなければ、`similarity()` を**埋め込みの類似度に差し替え**ればよく、`group_near_duplicates` の呼び出し側は変わりません。環境変数 `SEMANTIC_DEDUP=0` で無効化、`SEMANTIC_DEDUP_THRESHOLD` でしきい値を変えられます。

## 確認問題

1. 日本語のタイトルで、2-gram を使うのは、なぜですか。
2. 「6.1」と「6.2」だけが違うタイトルを、統合しない仕組みは何ですか。
3. しきい値を 0.95 と高くするのは、なぜですか。
4. 同じ話題の公式と個人記事で、公式を残すのは、なぜですか。

## 解答

1. 日本語は、**単語の区切りが無く**、形態素解析を入れたくない(依存を軽く保つ)。隣り合う 2 文字なら、**区切りなしで**、似た文字列を拾える。
2. **数字列が一致しない**タイトルは、類似度に関わらず、重複としない(`_numbers_differ`)。
3. **誤った統合**(別の話題を 1 つにする)のほうが、**見逃し**(重複が残る)より害が大きいから。
4. 公式は**一次情報**で、信頼できる。個人記事は、公式の解説・転載のことが多い。

## まとめ

- タイトルを「英単語 + 日本語の 2-gram」の袋にして、**コサイン類似度**で比べる。標準ライブラリだけ。
- **数字列の一致・高いしきい値・短い題の完全一致・切れた題の要約**で、誤統合を防ぐ。
- 代表は **公式 > 論文 > 個人記事**。`similarity` は差し替えられる。
- 次の回は、分類(補助)。
