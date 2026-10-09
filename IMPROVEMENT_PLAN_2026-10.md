# Research-Collector 改善書(2026-10 X調査反映)

作成日: 2026-10-07 / 対象: GitHub Actions × NotebookLM による技術情報の自動収集(Zenn / Qiita / Unity・UE公式 / CEDEC / arXiv / Semantic Scholar、毎日AM6時、週次レポート)
関連: [X_POSTS_BY_GENRE_2026-10.md](../X_POSTS_BY_GENRE_2026-10.md)、既存の [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md)

## 改善項目一覧

| ID | ジャンル | 改善内容 | 出典 | 効果 | 工数 |
|---|---|---|---|---|---|
| S1 | G1 | 収集した記事の振り分け(Game-Dev-Tech / Graphics-Research / Software-Engineering)を、選択問題として分類モデルで補助 | Jev の「Choice」型 / 30選 | 振り分けの精度と速度 | 中 |
| S2 | G1 | 重複判定をURLだけでなく意味でも行う(同じ話題の別記事をまとめる) | EmbeddingGemma 2 | レポートの重複が減る | 中 |
| S3 | G2 | 新しい収集元の追加: SideFX(Houdini)のリリースノート、Unreal 5.x の PCG、Cloudflare の変更履歴、モデルの公開ページ | 今回の強化領域 | 強化したい領域の追跡 | 小 |
| S4 | G2 | X投稿の取り込み(自分が選んだURLのみ。要約 + 出典URL) | 今回の調査の流れ | 調査を手でやらなくて済む | 中 |
| S5 | G2 | スキル・プラグイン配布サイトの新着監視(導入はしない。通知のみ) | skills.sh | 情報収集のみ | 小 |
| S6 | G2 | 収集処理の隔離方針(自前ランナーを使う場合の権限) | mania_3 / k1ito | 事故の被害限定 | 小 |
| S7 | G2 | 運用ルール(やること / やらないこと / 成果物)を `DOCUMENT.md` に明文化 | ai_300 | 自動化の暴走防止 | 小 |

## Phase 1: S3 / S7(すぐできる)
- `collectors/` に新しい収集元を追加する。RSSやリリースノートの更新ページから。
- 運用ルールは「やること: 収集・振り分け・要約」「やらないこと: 自動での公開・外部への送信」「成果物: 週次レポート・重複ログ」。

## Phase 2: S1 / S2
- S1: 入力は記事タイトル + 要約、選択肢は3つのノートブック名 + 「どれでもない」。**どれでもないは人に回す**。英語ラベルで試し、日本語記事での精度は自データで測る(公式は英語が最高精度としている)。
- S2: 埋め込みの類似度が高い記事を同じグループにして、レポートでは代表1本に統合する。閾値は実データで調整する。

## Phase 3: S4 / S5
- S4: 取得は、ユーザーが指定したURLのみ。サードパーティの中継サービス(fxtwitter)に依存するため、取得できない場合は静かに失敗し、再試行する。
- S5: 新着の通知のみ。導入は人が確認してから。

## Final Phase
- SETUP.md / DOCUMENT.md に新しい収集元と運用ルールを反映する。`health.json` の項目も増やす。

**検証チェックリスト:**
- [x] 新しい収集元が重複なく取り込まれる — 実フィードで13件(SideFX 5・Cloudflare 5・Hugging Face 3)+ PCGタグを取得。通しの2回目の実行では取得済みがスキップされた
- [x] 分類の「どれでもない」が正しく人に回る — 無関係なタイトルは棄権し、`health.json` の `unclassified` と `results.html` の「未分類(要確認)」に出る。実データ234件で5.1%が人に回った
- [x] 意味での重複判定で、別の話題を誤ってまとめていない — 実データ234件で確認。当初の閾値0.80では「連載その1〜4」「OS別のCloudflare記事」が統合されるため、数字列の一致ルールと閾値0.95を追加。最終的に統合されたのはZenn/Qiitaの転載1組のみ
- [x] 失敗した取得が `health.json` に記録される — `source_failures` に記録。これまで見えなかった `unity.com/releases/.../feed` の404が判明して削除。存在しないX投稿の失敗も記録されることを確認

## 実装状況(2026-10-10)

| ID | 状態 | 実装 |
|---|---|---|
| S1 | 完了 | `nbklm/classifier.py`。キーワード方式(日本語は自データで測る運用)。一致83.8% / どれでもない5.1% / 不一致11.1% |
| S2 | 完了 | `nbklm/semantic_dedup.py`。文字n-gramのコサイン類似度(埋め込みモデルは使わず標準ライブラリのみ)。閾値0.95 |
| S3 | 完了 | SideFX / Cloudflare 変更履歴 / Hugging Face ブログ(`release_notes_collector.py`)、UE PCG(Zenn・Qiitaの`pcg`タグ) |
| S4 | 完了 | `x_posts_collector.py` + `x_urls.txt`。本文+出典URLをテキストソースで追加。失敗は静かにスキップして次回再試行 |
| S5 | 完了 | `watch_collector.py`(skills.sh)。通知のみ。初回は現状を既知として保存 |
| S6 | 完了(文書) | DOCUMENT.md 12.9 |
| S7 | 完了(文書) | DOCUMENT.md 12.8 |

**計画からの変更点**
- S1/S2は「分類モデル」「EmbeddingGemma」ではなく軽量な標準ライブラリ実装にした。理由: GitHub Actionsに重い依存・モデルのダウンロードを入れたくないこと、日本語での精度を自データで測る前に外部モデルへ依存したくないこと。`classify()` / `similarity()` の入出力を保ったまま差し替えられる。
- 振り分け先(source_type由来のカテゴリ)は変えていない。分類は「妥当かの補助」にとどめた(計画の「補助」に合わせた)。
- S3の「モデルの公開ページ」はHugging Faceのブログと解釈した。ほかのページを指す場合は `STATIC_FEEDS` に足せばよい。

**分かったこと(要判断)**: 分類器はCEDEC 35件中22件を「ゲーム開発」と判定したが、CEDECの振り分け先は Graphics-Research + Software-Engineering で Game-Dev-Tech を含まない。足すかどうかは運用上の判断として残している。

## 注意・未確認
- 認証更新(Windowsタスクスケジューラ)に依存する部分は、今回触れていない。
- X のデータ取得の安定性は、中継サービスの継続に依存する。
- **NotebookLM のテキストソース追加(`add_text`)は、実サービスでは未確認**。実装時にローカルの認証が失効しており、模擬での確認にとどまる。認証を通してから `python scripts/check_text_source.py` を1回実行して確かめる(使い捨てのノートブックを作って削除する)。`x_urls.txt` が空のうちはこの経路は使われない。
- GitHub Actions 上での初回の実行は、このコミットのpush後。`gh workflow run daily_collect.yml` で手動実行して `health.json` と `results.html` を確認する。
- `unity.com/releases/lts-vs-tech-stream/feed` は404のため削除した(Unityのリリース情報の代替は未設定)。


---

## UI/デザイン改善(2026-10 追補)

参照: [UI_DESIGN_PRINCIPLES_2026-10.md](../UI_DESIGN_PRINCIPLES_2026-10.md)(原則 P1〜P10)/ 設計: [IMPROVEMENT_DESIGN_2026-10.md](IMPROVEMENT_DESIGN_2026-10.md)
追加の参考: 東京終電図・ONE ASIA ATLAS・文字画像APNGメーカー・中台の小さな家・re-presentation.jp と、デザインに関する2件の記事。
**方針**: 骨格(配色・書体・レイアウト)は維持し、「決めていないこと」を無くす方向で直す。装飾は足さない。

| ID | 原則 | 改善内容 | 工数 |
|---|---|---|---|
| U1 | P4 | `index.html` を、見出し + 主要数値(今週の収集数・ノートブック数)の入口に | 小 |
| U2 | P3 | カテゴリチップ + 2段の行(見出し + 副題 + 日付)の一覧 | 中 |
| U3 | P1 | 決めごと表と、日付・件数の等幅数字 | 小 |
| U4 | P10 | ライトテーマの追加(現状は暗いテーマ) | 小 |
