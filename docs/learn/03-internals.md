# 3. 内側のしくみ

## 1. 収集の隔離(`main.py` の `_collect`)

収集元は 8 種類以上あり、**どれかが落ちる**のは日常です(サイトの変更・API の制限)。`_collect(label, fn)` は、**1 つの失敗を捕まえて記録し、次へ進みます**。失敗した記事は `collectors/retry.py`(`record_failure`・`pop_failures`)が覚え、次回に**再試行**します。**全体が止まらない**ことを優先しています。

## 2. URL の重複(`seen_urls`)

`_url_hash(url)` = `SHA-256(url)` の先頭 **16 文字**(64 ビット)。`filter_new_articles` が、`seen_urls.txt` のハッシュと照らして新規だけを返し、記事に `url_hash` を付けます。**ファイルは増え続ける**(消す仕組みは無い。[6 トラブル](06-troubleshooting-maintenance.md))。

## 3. 意味の重複と分類

講義[第 1・2 回](../lecture/01-semantic-dedup.md)のとおり。順序は **URL → 意味 → 分類**。意味の重複は、**既に追加した記録**(`recent`)とも比べる(前日の記事との重複も除く)。

## 4. NotebookLM への追加(`nbklm/client.py`)

- **週次のノートブック**を、カテゴリごとに**名前で探し、なければ作る**(`_get_or_create_weekly_notebook`)。名前は、カテゴリごとのテンプレート(`CATEGORY_TO_NOTEBOOK_NAME`。`{YYYY}`・`{WNN}` に **ISO 週**の年・週番号が入る)。
- 記事の `source_type` から、追加先のカテゴリが決まる(`notebook_ids.py`。**分類の補助ではなく、こちらが実際の振り分け**)。
- 追加は**非公式のクライアント**(`notebooklm-py`)経由。認証は `NOTEBOOKLM_AUTH_JSON`(ブラウザの認証情報)。
- 古いノートブックは、総数が上限(`MAX_NOTEBOOKS`)を超えたとき `notebook_cleanup` が、**古い週から**整理する。**自動生成の週次ノートブックだけ**が対象で、手動で作ったものと固定のものは**保護**される。

## 5. エピソード・ダイジェスト(`episodes.py`・`digest.py`)

`articles_log.json` の記録から、**日次・週次のまとまり**(エピソード)を作る(`build_daily`・`build_weekly`)。週のラベルと日の集合(`week_label`・`week_days`)・**週のキーワード**(今週に多く、前の週に少ない語。`week_keywords`)を持つ。ダイジェストは、NotebookLM に作らせた Markdown を、見出しで分けて保存する(`parse_digest_markdown`)。

## 6. 収集結果のページ(`build_site.py`)

`articles_log.json`・`health.json` から、**期間・カテゴリで絞れる**一覧 `results.html` と、入口 `index.html` の数値を作る。**外から来る文字列は、エスケープして HTML に入れる**(収集した題名・要約をそのまま埋めない)。失敗しても、収集の結果は残す(ワークフローの別のステップ)。

## 7. ワークフローの最後(bot のコミット)

`daily_collect.yml` の最後で、`github-actions[bot]` が **`health.json`・`README.md`・`seen_urls.txt`**(と、存在する生成物)をコミットして push します。そのため:

- **README の `HEALTH_START` 〜 `HEALTH_END` のマーカー**を消すと、表が更新されなくなる(`update_readme_health.py` がこの間を書き換える)。
- **人の push と、bot の push が競合**しうる(リモートが先に進む)。手元では、`git pull --rebase` してから push する。
