# 6. トラブルと保守

## 症状 → 原因 → 直し方

| 症状 | 原因 | 直し方 |
|---|---|---|
| **NotebookLM への追加が止まった** | 認証(`NOTEBOOKLM_AUTH_JSON`)の期限切れ・更新の失敗 | PC のタスク(`refresh_auth.ps1`)が動いているか確認。`python main.py --mode check` で確かめ、Secret を更新 |
| 収集が 0 件の収集元がある | サイトの変更・API の制限(429)・一時的な障害 | ログ(`output/`・Actions の成果物)を見る。次回に再試行される。論文は `SEMANTIC_SCHOLAR_API_KEY` で上限が上がる |
| 同じ話題が、重複して追加される | 意味の重複のしきい値(0.95)に届かない | 固定のタイトルで確かめ、必要ならしきい値を調整(誤統合に注意) |
| 別の話題が、統合されて消えた | しきい値が低すぎる・数字を含まないタイトル | `SEMANTIC_DEDUP=0` で無効にして確かめる。連載・バージョンの数字は、既に別扱い |
| 「未分類」が多い | キーワードの表に無い語 | `_KEYWORDS` に足す(講義第 2 回) |
| **README の「直近の実行」の表が更新されない** | `HEALTH_START` / `HEALTH_END` のマーカーを消した | マーカーを戻す(README に 1 つだけ) |
| **push が拒否される**(non-fast-forward) | bot が先に push した(health・README・seen_urls) | `git pull --rebase`(手元に未コミットがあるなら、退避してから) |
| Actions の `git push` が失敗 | 手元の push と競合・権限 | `permissions: contents: write` を確認 |
| 収集結果ビューが空 | `articles_log.json` が空・`build_site.py` の失敗 | ワークフローのログを確認(失敗しても収集の結果は残る) |

## 既知の問題・注意(コードは変えていない)

講義・学習資料の作成中に、コードを読んで・動かして見つけたものです。

1. **`seen_urls.txt` は増え続ける**(消す仕組みが無い)。毎回、全体を**ソートして書き直す**ので、行が増えるほど差分・書き込みが大きくなる。期限つきの管理(日付つきのハッシュ)が要る。
2. **NotebookLM への追加は、非公式のクライアント(`notebooklm-py` の固定版)と、ブラウザの認証情報**に依存する。認証の期限・クライアントの変更で、突然止まりうる。
3. **意味の重複のしきい値(0.95)は、実データで決めた値**で、OS 別の別記事(0.94)を分けるぎりぎりの位置。**同じ話題でも、題名が長く違うと、統合されない**(見逃しは許容する設計)。
4. **分類のキーワードの表は手書き**。日本語の精度は、`agreement_report()` で、自データから測る前提(未評価)。
5. **bot と人の push が競合する**。bot は 1 日 2 回、`health.json`・`README.md`・`seen_urls.txt` ほかを push する。
6. **作業ツリーに、この文書とは別の未コミットの変更**(`ResearchBroadcast_DESIGN.md`・`broadcast/` ほか)がある場合がある。コミットは、ファイルを**指定**して行う。
7. `articles_log.json` は `RETENTION_DAYS` と `MAX_ENTRIES` で刈り込む。**古い記事は記録から消える**(NotebookLM 側には残る)。

## 定期の保守

| いつ | 何を |
|---|---|
| 毎回の変更 | `python -m unittest discover tests` と `python tools/check_docs.py` |
| 毎週 | `health.json`・README の表で、収集元ごとの件数・失敗を見る |
| 月 1 回 | 依存(`notebooklm-py`・`feedparser`・`requests`)の更新は、**固定版を上げる前にテスト** |
| 月 1 回 | `seen_urls.txt` の大きさ・ノートブックの総数(`MAX_NOTEBOOKS`) |
| 認証 | Secret の更新手順(`refresh_auth.*`)・PC のタスクの生存 |
| 関数を直したとき | `python tools/check_docs.py --update` で、文書の引用・出力を作り直し、**説明が合っているか**を読む |
