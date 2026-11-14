# 2. コードの読み方(どこに何があるか)

## ファイルの地図

| 場所 | 行数の目安 | 役割 | 読む順 |
|---|---|---|---|
| `main.py` | 360 | 入口。`check`・`daily`・`weekly`(収集の全体の流れ) | ① |
| `collectors/*.py` | 160〜530 | ソースごとの収集(`zenn_qiita`・`unity_ue`・`cedec`・`paper`・`release_notes`・`x_posts`・`game_media`・`watch` ほか) | ② |
| `collectors/_academic_api.py`・`_text.py`・`retry.py` | 420・–・– | 論文 API の共通処理・テキスト整形・失敗の再試行 | |
| `nbklm/seen_urls.py` | 60 | URL のハッシュで重複を除く | ③ |
| `nbklm/semantic_dedup.py` | 190 | 意味の重複(**標準ライブラリだけ**) | ④ |
| `nbklm/classifier.py` | 165 | 分類の補助(キーワードの重み) | ⑤ |
| `nbklm/client.py` | 420 | NotebookLM への追加・週次ノートブック・レポート生成 | ⑥ |
| `nbklm/episodes.py`・`digest.py` | 310・145 | 日次・週次の「エピソード」・ダイジェスト | |
| `nbklm/articles_log.py`・`notebook_cleanup.py`・`auth_monitor.py` | – | 記録・古いノートブックの整理・認証の期限の確認 | |
| `scripts/build_site.py` | 540 | `results.html`・`index.html` の生成 | |
| `scripts/post_ingest.py`・`enrich.py`・`notify.py`・`post_report.py` | 150〜270 | ResearchBroadcast への送信・要約・通知 | |
| `scripts/backup_d1.py`・`update_readme_health.py` | – | D1 のバックアップ・README の健康状態の表の更新 | |
| `broadcast/` | – | ResearchBroadcast(Cloudflare 上の別システム。Node のテストあり) | |
| `.github/workflows/` | – | `daily_collect.yml` ほか | |

**読み方**: ①(流れ)→ ②(1 つの収集元)→ ③④⑤(重複と分類)→ ⑥(追加)。

## テスト

`tests/`(`unittest`・`pytest` どちらでも): `test_2026_10.py`(重複・分類・変更履歴・X の回帰)・`test_episodes.py`・`test_report.py`・`test_broadcast.py`・`test_notify.py`・`test_enrich.py`・`test_game_media.py`・`test_backup.py`・`test_s2_retry.py`・`test_week_keywords.py`。**ネットワーク不要・標準ライブラリ**。

## 設計書・設定

| 場所 | 内容 |
|---|---|
| `IMPROVEMENT_PLAN_2026-10.md`・`IMPROVEMENT_DESIGN_2026-10.md` | 2026-10 の改善(S1〜S4 ほか) |
| `ResearchBroadcast_DESIGN.md` | ResearchBroadcast の設計 |
| `nbklm/notebook_ids.py` | ソースの種類 → ノートブックのカテゴリの対応(**実際の振り分け**) |
| `x_urls.txt` | X の投稿の URL(ここに書いたものだけ取得) |
