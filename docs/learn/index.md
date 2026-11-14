# Research-Collector 学習資料(簡易版)

保守・拡張の詳しい資料は**未作成**です。基礎は [講義](../lecture/index.md)(第 0〜2 回)。既存の資料: [DOCUMENT.md](../../DOCUMENT.md)・[HANDSON.md](../../HANDSON.md)・[SETUP.md](../../SETUP.md)・[LOCAL_EXTRA_GUIDE.md](../../LOCAL_EXTRA_GUIDE.md)。旧 README は [readme-detail.md](../reference/readme-detail.md)。

## コードの地図

| 場所 | 役割 |
|---|---|
| `main.py`(約 360 行) | 収集の全体の流れ |
| `collectors/` | ソースごとの収集(Zenn・Qiita・公式ブログ・arXiv・Semantic Scholar・CEDEC・変更履歴 ほか) |
| `nbklm/semantic_dedup.py`・`classifier.py` | 意味の重複・分類(標準ライブラリだけ) |
| `nbklm/client.py`・`episodes.py`・`digest.py` | NotebookLM への追加・エピソード・ダイジェスト |
| `scripts/` | 通知・取り込み・サイト生成(`build_site.py`)・レポートの投稿 |
| `broadcast/` | ResearchBroadcast(Cloudflare 上の別システム。Node のテストあり) |
| `tests/` | `python -m unittest discover tests`(ネットワーク不要) |

## 注意・既知の点(講義の作成中に読んで見つけたもの。コードは変えていない)

1. **類似度のしきい値(0.95)は、実データで決めた値**で、OS 別の別記事(0.94)を分けるぎりぎりの位置。タイトルの語が増えると、同じ話題でも 0.95 に届かず、**統合されない**ことがある(見逃しは許容する設計)。
2. **分類のキーワードの表は手書き**。新しい用語は、表に足さないと拾えない。「どれでもない」が増えたら見直す。
3. **日本語の分類精度は未検証**(`agreement_report()` で自データから測る前提)。
4. NotebookLM への追加は、**非公式の認証**(ブラウザの認証情報の更新が要る)に依存する。更新が止まると、追加が止まる(`refresh_auth.*`・タスクスケジューラ)。
5. 作業ツリーに、この文書とは別の**未コミットの変更**(`ResearchBroadcast_DESIGN.md`・`broadcast/` ほか)がある。
