# Research Collector

**GitHub Actions × NotebookLM による技術情報の自動収集システム**。一度セットアップすれば、毎日 AM 6 時に自動で動き続けます。

![構成図](docs/diagrams/architecture.svg)

## 状態

| 項目 | 内容 |
|---|---|
| 収集 | Zenn・Qiita・Unity / UE の公式ブログ・CEDEC・arXiv・Semantic Scholar・変更履歴 ほか |
| 重複の除去 | URL の完全一致 + **意味の近さ**(タイトルの類似度) |
| 分類 | 3 カテゴリ + 「どれでもない」(**補助**。迷ったら人の確認に回す) |
| テスト | `python -m unittest discover tests`・`python -m pytest tests/test_docs.py`(ネットワーク不要) |
| 学習資料 | 講義 3 回+保守・拡張の学習資料(全体像・コードの読み方・内側のしくみ・拡張・テスト・トラブルと保守・用語集) |

## 直近の実行(自動で更新される)

<!-- HEALTH_START -->
| 実行 | 最終実行 | 詳細 |
|---|---|---|
| Daily Collect | ✅ 2026-11-14T09:04:03Z | 収集109件 / 新規16件 / NotebookLM追加20件 / 要確認1件 / 重複統合3件 |
| Weekly Digest | ✅ 2026-11-02T09:04:36Z | 13718文字生成 |
<!-- HEALTH_END -->

## できること(概要)

毎日の自動収集・論文の収集(週 2 回)・重複の除去・分類の補助・NotebookLM への自動追加・週次レポート・収集結果ビュー(`results.html`)・ResearchBroadcast への送信(任意)・認証の自動更新。**収集元・手順・設定の詳細は [旧 README の詳細](docs/reference/readme-detail.md)**。

## ドキュメント

| 読みたいもの | 場所 |
|---|---|
| 全体の地図 | [docs/index.md](docs/index.md) |
| **基礎から学ぶ**(講義 3 回・実行できる例つき) | [docs/lecture/](docs/lecture/index.md) |
| コードの地図・既知の点 | [docs/learn/index.md](docs/learn/index.md) |
| 収集元・手順・設定の**詳細**(旧 README) | [docs/reference/readme-detail.md](docs/reference/readme-detail.md) |
| セットアップ・ハンズオン | [SETUP.md](SETUP.md)・[HANDSON.md](HANDSON.md)・[DOCUMENT.md](DOCUMENT.md) |

## 限界(正直に)

- 分類は**キーワードの表**で、日本語の精度は自データで測る前提です。迷ったものは「どれでもない」になります。
- NotebookLM への追加は、**非公式の認証**に依存します。認証の更新が止まると、追加が止まります。
- 意味の重複の判定は、**誤統合を避けるため厳しめ**です。同じ話題が、少し残ることがあります。
