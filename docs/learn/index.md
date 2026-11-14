# Research-Collector 学習資料(保守・拡張の実務編)

このフォルダは、**このシステムを直す・足す人**のための資料です。基礎から順に学ぶ講義は [../lecture/index.md](../lecture/index.md)(第 0〜2 回)。既存の資料: [DOCUMENT.md](../../DOCUMENT.md)・[HANDSON.md](../../HANDSON.md)・[SETUP.md](../../SETUP.md)。旧 README は [readme-detail.md](../reference/readme-detail.md)。

| # | 資料 | いつ読むか |
|---|---|---|
| 1 | [全体像](01-overview.md) | 1 日の流れ・Actions・データの置き場所・環境変数 |
| 2 | [コードの読み方](02-code-tour.md) | どのファイルから読むか |
| 3 | [内側のしくみ](03-internals.md) | 収集の隔離・重複・記録・エピソード・レポート・通知 |
| 4 | [拡張のレシピ](04-extend.md) | 収集元・分類・通知・ノートブックを**足したい** |
| 5 | [テストの書き方と実行](05-testing.md) | テストを回す・足す・文書の検査 |
| 6 | [トラブルと保守](06-troubleshooting-maintenance.md) | 動かない・**認証の期限**・既知の問題・定期の保守 |
| 7 | [基礎の補強](07-foundations.md) | Python・正規表現・Counter・非同期・類似度・設計思想・収集と AI の用語を**補強したい** |
| – | [用語集](glossary.md) | 分からない言葉が出た |

## 最初の 15 分

1. `python -m unittest discover tests` を通す(ネットワーク不要・標準ライブラリ)。
2. [構成図](../diagrams/architecture.svg)を見ながら、[全体像](01-overview.md)を読む。
3. `nbklm/semantic_dedup.py` と `classifier.py` を、講義[第 1・2 回](../lecture/01-semantic-dedup.md)と並べて読む。

## 目的別の近道

| やりたいこと | 読む場所 |
|---|---|
| 収集元(RSS・API)を足す | [4 拡張](04-extend.md) レシピ 1 |
| 分類のキーワードを直す | [4 拡張](04-extend.md) レシピ 2・講義[第 2 回](../lecture/02-classifier.md) |
| 通知・送信を足す | [4 拡張](04-extend.md) レシピ 4 |
| 追加が止まった | [6 トラブル](06-troubleshooting-maintenance.md)「認証」 |
| README が bot に上書きされる | [6 トラブル](06-troubleshooting-maintenance.md)「README のマーカー」 |
