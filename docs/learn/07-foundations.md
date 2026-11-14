# 7. 基礎の補強(言語・設計思想・アルゴリズム・用語)

講義と学習資料の**前提になっている知識**を、ここで補います。「Python・正規表現・ベクトルの基本」を、**このシステムのコードで実際に使われている形**で、動かして確かめます。

## 1. 言語の基礎: Research-Collector で使う Python

### 1.1 文字の正規化(`unicodedata`)と `str` のメソッド

同じ見た目でも、**文字としては別**のことがある(全角の `Ｕｎｉｔｙ` と半角の `Unity`)。比べる前に **NFKC 正規化**し、**小文字**にそろえ、**空白を 1 つ**にする。重複の判定は、**この下ごしらえで決まる**。

```python
# 実行できる
import re
import unicodedata


def normalize(title: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", title or "").lower()).strip()


a = "Ｕｎｉｔｙ　６　が　リリース"       # 全角の英数・全角スペース
b = "unity 6 が リリース"
print(repr(normalize(a)))
print("同じになる:", normalize(a) == normalize(b))
print("None でも落ちない:", repr(normalize(None)))
```

```text
# 出力
'unity 6 が リリース'
同じになる: True
None でも落ちない: ''
```

### 1.2 `Counter`: 数える

`collections.Counter` は、**要素ごとの出現数**を数える辞書。「英単語と、日本語の文字 2 つ組(2-gram)の出現数」で、**文章を数の組(特徴)に変える**。

```python
# 実行できる
from collections import Counter

words = "unity unity render".split()
print(Counter(words))

text = "天気予報"
bigrams = Counter(text[i:i + 2] for i in range(len(text) - 1))      # 2 文字ずつずらして切る(2-gram)
print(bigrams)
print("足し合わせる:", Counter("ab") + Counter("bc"))
```

```text
# 出力
Counter({'unity': 2, 'render': 1})
Counter({'天気': 1, '気予': 1, '予報': 1})
足し合わせる: Counter({'b': 2, 'a': 1, 'c': 1})
```

### 1.3 正規表現: 単語の境界

`"api"` を探して、`"capital"` の中の `api` に当たると**誤爆**。**短い語は単語の境界**(前後が英数字でない)で照合し、**長い語は部分一致**にする(`classifier.py` の `_compile`)。

```python
# 実行できる
import re

short = re.compile(r"(?<![a-z0-9])" + re.escape("api") + r"s?(?![a-z0-9])")      # 境界つき
partial = re.compile(re.escape("api"))                                           # 部分一致

for text in ["new api released", "capital markets", "web apis"]:
    print(f"{text:18s} 境界つき:{bool(short.search(text))!s:5s} 部分一致:{bool(partial.search(text))}")
```

```text
# 出力
new api released   境界つき:True  部分一致:True
capital markets    境界つき:False 部分一致:True
web apis           境界つき:True  部分一致:True
```

### 1.4 `async` / `await` と `asyncio.run`

NotebookLM への登録は、**待ち時間の長い通信**なので、**非同期**(`async def`)の関数。同期のコードから呼ぶときは、`asyncio.run(...)` で**1 回だけ実行して結果を受け取る**(`client.py` の `asyncio.run(add_articles_to_notebooklm(...))`)。

```python
# 実行できる
import asyncio


async def add_articles(articles: list[str]) -> int:
    await asyncio.sleep(0.01)             # 通信を待つ、の代わり
    return len(articles)


def add_articles_sync(articles: list[str]) -> int:       # 同期の呼び出し口
    return asyncio.run(add_articles(articles))


print("登録した件数:", add_articles_sync(["a", "b", "c"]))
```

```text
# 出力
登録した件数: 3
```

## 2. 設計思想

| 原則 | 意味 | RC のどこに出るか | 破るとどうなるか |
|---|---|---|---|
| **まず軽く・確実に** | 重い機械学習を避け、**単語と文字の数**で近さを測る | `semantic_dedup.py`(軽量な特徴 + コサイン) | 実行環境・時間・コストが膨らむ |
| **人に回す(自信が無いときは決めない)** | 当たりが少なければ「要確認」にする | `classifier.py` の `MIN_SCORE` | 間違った分類が、静かに混ざる |
| **弱い事前情報** | 出どころで、話題をうっすら絞る | `_SOURCE_PRIOR`(強制ではなく、加点) | 出典の性質を無視して、取りこぼす |
| **収集元の失敗を、全体に広げない** | 1 つの収集元が落ちても、他は続ける | `collectors/` の隔離 | 1 つの障害で、毎日の収集が止まる |
| **記録を残す(重複排除・健康状態)** | 見たものを覚え、状態を出す | `seen_urls.txt`・`health.json` | 同じ記事を何度も登録する・止まっても気づかない |
| **無人で動く前提で作る** | 人がいなくても、安全に失敗する | GitHub Actions・認証の期限切れ検知 | 黙って止まる |
| **公式でない手段は、そう書く** | 非公式の認証などは、限界を文書に書く | NotebookLM の認証(非公式) | 仕様変更で突然動かなくなる |

## 3. 関数・アルゴリズム

| 名前 | 場所 | 何をする | 計算量・注意 |
|---|---|---|---|
| **特徴の抽出** | `features` | 英単語 + 日本語の 2-gram の出現数 | O(文字数) |
| **コサイン類似度** | `similarity` | 2 つの特徴ベクトルの**向きの近さ**(0〜1)。`内積 / (長さ × 長さ)` | O(特徴の数)。**文章の長さに左右されにくい** |
| **近い重複のグループ化** | `group_near_duplicates` | しきい値以上に似た記事を、1 グループにまとめる | 記事の組み合わせ(O(n²))。**数字が違えば別の記事**として扱う(`_numbers_differ`) |
| **キーワード加点の分類** | `classify` | 話題ごとの語に重みをつけて、合計が最大のものを選ぶ | O(語数)。**最低点未満は「要確認」** |
| **URL の重複排除** | `seen_urls.txt` | 見た URL の集合に、含まれるか | 集合なら O(1)(ファイル全体の読み込みが要る) |

```python
# 実行できる
from nbklm.semantic_dedup import features, similarity

pairs = [
    ("Unity 6 released", "Unity 6 is released"),
    ("Unity 6 released", "Unreal Engine 5.4 update"),
    ("天気予報の仕組み", "天気予報のしくみ"),
    ("Unity 6 released", "Unity 6 released"),
]
for a, b in pairs:
    print(f"{similarity(features(a), features(b)):.2f}", "|", a, "|", b)
```

```text
# 出力
0.82 | Unity 6 released | Unity 6 is released
0.00 | Unity 6 released | Unreal Engine 5.4 update
0.57 | 天気予報の仕組み | 天気予報のしくみ
1.00 | Unity 6 released | Unity 6 released
```

- **0 に近いほど別、1 に近いほど同じ**。**しきい値**(どこから「同じ」とするか)は、**誤って消す**(別の記事を重複と判断)と**取りこぼす**(重複を残す)の**トレードオフ**。環境変数で変えられるのは、そのため。
- **単語の数だけを見る**ので、**意味**は見ない(「Unity」と「ユニティ」は別)。軽さの代わりの限界。

## 4. IT・エンタメの用語の補強

| 用語 | 意味 | RC での出番 |
|---|---|---|
| **RSS / Atom** | サイトの更新を、機械が読める形で配る仕組み | 収集元 |
| **スクレイピング** | Web ページから、情報を機械で取り出すこと(相手の規約・負荷に配慮) | 収集 |
| **GitHub Actions / cron** | 自動で定期実行する仕組み / 時刻の指定 | 毎日の実行 |
| **arXiv / 論文のプレプリント** | 査読前の論文の公開場所 | 収集元(`arxiv`) |
| **CEDEC** | 日本のゲーム開発者向けの大きなカンファレンス | 収集元(`cedec`) |
| **Unity / Unreal Engine / Houdini** | ゲームエンジン / 同 / 映像・ゲーム向けの 3D ツール | 話題の分類 |
| **NotebookLM** | Google の、資料を読み込ませて質問・要約できる AI ノート | 登録先 |
| **ダイジェスト** | 週ごとなどの、要約のまとめ | 週次の生成 |
| **n-gram** | 連続する n 個の文字(単語)の並び | 日本語の特徴 |
| **ベクトル / コサイン類似度** | 数の組 / その向きの近さ | 重複判定 |
| **しきい値(閾値)** | 判定の境目の値 | 重複・分類 |
| **要約(summary)・出典** | 記事の短い説明 / 元の URL | 登録内容 |
| **認証の期限(トークン / Cookie)** | ログイン状態の有効期間 | 認証の更新 |

## 確認問題

1. 比較の前に、文字を NFKC で正規化するのは、なぜですか。
2. `"api"` のような短い語を、単語の境界で照合するのは、なぜですか。
3. コサイン類似度が、記事の長さに左右されにくいのは、なぜですか。
4. 重複判定のしきい値を上げると、何が起き、何が悪くなりますか。

## 解答

1. 全角・半角・大文字小文字の違いを消して、同じ内容を、同じ文字列として比べるため。
2. `capital` の中の `api` のような誤爆を避けるため。
3. 内積を、2 つのベクトルの長さで割るので、向き(単語の割合)だけを見ているから。
4. 厳しくなり、重複と判定される記事が減る。重複した記事が、残りやすくなる(取りこぼし)。
