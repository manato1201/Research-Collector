# 4. 拡張のレシピ

どれも「**設定(データ)→ 関数 → テスト**」の順で、小さく進めます。**1 つの収集元の失敗が、全体を止めない**(`_collect` の中に入れる)のが原則です。

## 週とハッシュの感覚をつかむ

```python
# 実行できる
import datetime

from nbklm import episodes
from nbklm.seen_urls import _url_hash

label = episodes.week_label(datetime.date(2026, 11, 14))
print("週のラベル:", label, "/ その週の日:", episodes.week_days(label)[0], "〜", episodes.week_days(label)[-1])
print("URL のハッシュ:", len(_url_hash("https://example.com/a")), "文字 /", "同じ URL なら同じ値:", _url_hash("https://example.com/a") == _url_hash("https://example.com/a"))
```

```text
# 出力
週のラベル: 2026-W46 / その週の日: 2026-11-09 〜 2026-11-15
URL のハッシュ: 16 文字 / 同じ URL なら同じ値: True
```

## レシピ 1: 収集元(RSS・API)を足す

1. `collectors/<name>_collector.py` に `collect(max_per_feed=5) -> list[dict]`。各記事は `{"title", "url", "platform", "source_type", "summary", ...}`(既存の収集元の形に合わせる)。
2. `platform` を、`nbklm/semantic_dedup.py` の `_PLATFORM_RANK`(代表を選ぶ優先順)に足す(無ければ 5 = 最も低い)。
3. `source_type` を、`nbklm/notebook_ids.py` の振り分け(`SOURCE_TYPE_TO_CATEGORIES`)に足す(**実際の追加先が決まる**)。
4. `main.py` の `run_daily` に `_collect("<名前>", fn)` を足す(**`_collect` の中**に入れる)。
5. **ネットワークは、`collectors/retry.py` の失敗の記録**(次回の再試行)に任せる。外から来る文字列(題名・要約)は、**そのまま HTML に入れない**(`build_site.py` はエスケープする)。
6. **テスト**: 偽の RSS・偽の応答(`test_game_media.py` の形)。

## レシピ 2: 分類のキーワードを足す・直す

`nbklm/classifier.py` の `_KEYWORDS`(`(語, 重み)`)に足す。**4 文字以下の英字は単語境界**で照合される(誤爆を避ける)。直したら、**固定のタイトル**でテストする(`test_2026_10.py` の形)。**精度は、`agreement_report()` で、自分のデータから測る**。

## レシピ 3: 意味の重複を調整する

しきい値は環境変数 `SEMANTIC_DEDUP_THRESHOLD`(既定 0.95)。**下げる前に**、誤統合のパターン(連載・バージョン違い・OS 別)を、固定のタイトルでテストに入れる。差し替えるなら `similarity()` だけ(講義[第 1 回](../lecture/01-semantic-dedup.md))。

## レシピ 4: 通知・送信を足す

`scripts/notify.py` の形(`digest`・`failure` の 2 つのサブコマンド)に、サブコマンドを足し、`daily_collect.yml` に**任意のステップ**(`continue-on-error` か、失敗しても収集を止めない書き方)として足す。**Secrets** で渡し、**無ければ何もしない**(登録するまでは動かない設計)。

## レシピ 5: ノートブックの振り分けを変える

`notebook_ids.py` と `CATEGORY_TO_NOTEBOOK_NAME`(テンプレート)を直す。**既存の週次ノートブックの名前を変えない**(探すのが名前なので、変えると別のノートブックが作られる)。

## 変更の前に

- **README の `HEALTH_START` / `HEALTH_END` を消さない**(bot が更新する)。
- 変更したら `python -m unittest discover tests` と `python tools/check_docs.py`([5 テスト](05-testing.md))を通す。
