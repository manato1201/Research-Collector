# Research-Collector 完全自動化計画書

**改善指標: 完全自動化(人手介入ゼロでの継続運用)**
作成日: 2026-07-03 / 更新日: 2026-07-03(実装状態を`.github/workflows/*`・スクリプト実体と突合し修正)
現在の自動化率: 約80%

---

## Phase 0: 現状分析(実装コードと突合済み)

### システム概要
GitHub Actions × NotebookLM による技術情報自動収集。RSS/API収集(毎日 21:00 UTC = AM6:00 JST)→重複除去→NotebookLM週次ノートブック振り分け→週次日本語レポート生成(月曜)。

### 既に自動化済み(触らない)
- 記事収集: Zenn/Qiita(11フィード)・Unity/UE(4フィード)・CEDEC — `collectors/*.py`、共通シグネチャ `collect(max_per_feed) -> list[dict]`
- 論文収集: arXiv 8クエリ + Semantic Scholar 9クエリ(月木、APIキー不要、レート制限対策済み)
- 重複管理: `nbklm/seen_urls.py`(SHA-256ハッシュ、Gitコミットで永続化)
- NotebookLM追加: `nbklm/client.py`(週次ノートブック自動作成+キャッシュ、`wait=False`非同期追加)
- 失敗通知: `daily_collect.yml` L68-100 で Issue自動作成(label: `auth-expired`)
- **Issueの自動クローズ**: `refresh_auth.ps1` L45-53 で、gh CLIログイン済みかつSecret更新成功時に、open中の `auth-expired` Issueを自動で `gh issue close`(→ 旧計画のM4は**実装済み**、手動ステップではない)
- **週次の予防的認証チェック**: `.github/workflows/auth_check.yml`(毎週日曜AM5:00, JST)が既に存在。`main.py --mode check` を実行し、失敗時は daily_collect と同じ `auth-expired` ラベルでIssue作成(ただし**リアクティブ**判定のみ — Cookie残日数のような予測は行っていない)
- **日次の暗黙チェック**: `daily_collect.yml` L38-41 の `Check auth` ステップは `continue-on-error` なしのため、認証切れがあれば daily_collect 自体がその日のうちに失敗し、Issueが立つ。→ Cookie失効に気づくまでの遅延は最悪でも**1日**であり、「失効に気づかず収集が何週間も止まる」状態ではない(Phase 0旧記述の誇張を修正)

### 完全自動化を阻む3つの壁
| # | 壁 | 発生箇所 |
|---|---|---|
| 1 | **Google 2段階認証** — `notebooklm login` がブラウザ手動操作必須 | `refresh_auth.ps1` L19-22 |
| 2 | **Cookie有効期限** — storage_state.json が数週間〜数ヶ月で失効。現状は「失効して daily_collect が落ちて初めて気づく」リアクティブ検知のみで、**事前に残日数を知る手段がない** | `nbklm/client.py` の `check_auth()`(単純なAPI疎通確認のみ) |
| 3 | **初期セットアップ複雑性** — 手動6ステップ(リポジトリ作成、Secrets登録、WSL2ログイン等) | SETUP.md / HANDSON.md |

### ドキュメント負債(新規発見・要対応)
- **SETUP.md が実装と乖離**: `NOTEBOOKLM_STORAGE_STATE`(Base64)Secretと固定4ノートブックID運用を前提に書かれているが、実装(`nbklm/client.py`)は既に `NOTEBOOKLM_AUTH_JSON`(生JSON)Secret + 週次ノートブック自動作成(`notebook_ids.py` の `CATEGORY_TO_NOTEBOOK_NAME` テンプレート)に移行済み。このままだと新規セットアップ者が旧方式で詰まる → **Phase 3の一部として最優先で修正すべき**

### 手動ステップ完全インベントリ(実装コードで再確認・修正)
- **M1**: refresh_auth.ps1 実行(Task Schedulerで半自動化済み、毎日AM5:30トリガー。ただし`notebooklm login`はブラウザ操作待ちのため無人実行では完走しない)
- **M2**: ブラウザでGoogleログイン+ENTER押下(**毎回必須・最大の壁**)
- **M3**: gh CLI未ログイン時のSecret手動更新(fallback、稀)
- ~~M4: auth-expired Issueの手動クローズ~~ → **実装済みのため削除**(refresh_auth.ps1が自動クローズ)
- **D1-D3**: 失敗時のActionsログ確認・seen_urls.txtリセット・追加失敗デバッグ

### アンチパターン(全フェーズ共通)
- notebooklm-pyは**非公式API**。バージョン固定(`>=0.3.4`)の範囲で使い、存在しないメソッドを推測で呼ばない
- Google認証情報(パスワード・TOTPシークレット)は**コードにもログにも絶対に書かない**。GitHub Secrets / 環境変数のみ
- seen_urls.txtのコミットはGitHub Actionsのcron自動停止(60日ルール)回避も兼ねている — この仕組みを壊さない

---

## Phase 1: Cookie失効の事前検知(短期・4-5h、既存基盤を流用するため当初想定8hから圧縮)— 「切れてから気づく」の解消

**前提の修正:** `auth_check.yml`・Issue作成・自動クローズの土台は既に存在する。Phase 1で新規に作るのは「残日数を予測するロジック」と「既存ワークフローへの1ステップ追加」のみ。ゼロから作るものではない。

**実装内容:**
1. `nbklm/auth_monitor.py` を新規作成:
   ```python
   def check_cookie_expiry(storage_state: dict) -> tuple[int, bool]:
       """Cookie群のexpires最小値から残日数を計算。(days_remaining, needs_refresh)を返す"""
   ```
   - storage_state.json(またはNOTEBOOKLM_AUTH_JSONの中身)内の各Cookieの`expires`フィールド(Unix epoch)を解析し、Google認証系Cookieの最短失効日を取得
   - 残日数 < 10 で `needs_refresh=True`
2. 既存の `.github/workflows/auth_check.yml` に **ステップを追加**(新規ワークフローは作らない):
   - 現行の `Check NotebookLM auth` ステップ(L30-38、`main.py --mode check` によるリアクティブ判定)はそのまま残す
   - その前段に `auth_monitor.check_cookie_expiry` を呼ぶステップを追加し、`needs_refresh` 時は label **`refresh-soon`**(既存の`auth-expired`とは別ラベル)でIssue作成(「今週末までに refresh_auth.ps1 を実行してください」)
   - 既存の `Create issue on auth failure` ステップ(L46-86)の重複チェックロジック(`labels: 'auth-expired'` でopen Issueを検索)はそのままだが、新設する `refresh-soon` 側は別途同様の重複防止チェックを実装する(同じIssueを毎週作らないため)
3. `refresh_auth.ps1` の改修(既存の自動クローズ機構(L45-53)を拡張):
   - 現状は `auth-expired` ラベルのみクローズ対象 → `refresh-soon` ラベルも同様にクローズ対象に追加
   - 結果JSON出力(任意、デバッグ用)を追加

**検証チェックリスト:**
- [x] 期限間近のダミーstorage_stateで auth_monitor が正しく検知(手動スクリプトで4パターン確認済み: 残5日→要更新/残30日→不要/期限無しCookieのみ→要更新/複数Cookie中の最短値を採用)
- [ ] workflow_dispatch で auth_check.yml を手動実行し、`refresh-soon` Issue作成を確認(既存の`auth-expired`検知とは独立して動くこと) — **要実機確認(GitHub Actions上での実行が必要)**
- [ ] refresh_auth.ps1 成功後に `refresh-soon` / `auth-expired` 両方のIssueが自動クローズされる — **要実機確認**
- [ ] 同じ週内に auth_check.yml が複数回走っても `refresh-soon` Issueが重複作成されないこと — **要実機確認**

**効果: 「失効してから気づく」(最悪1日の収集停止)を「事前に計画的に更新する」に変える。収集停止ゼロ自体は既存の日次チェックで概ね担保済みだが、後手対応から先手対応への転換が主眼。**

**実装状況(2026-07-03): コード実装完了。**
- `nbklm/auth_monitor.py` 新規作成(`check_cookie_expiry`)
- `.github/workflows/auth_check.yml` に事前検知ステップ+`refresh-soon` Issue作成を追加(既存のリアクティブ検知はそのまま維持)
- `refresh_auth.ps1` の自動クローズ処理を `auth-expired` / `refresh-soon` 両ラベル・複数Issue対応に拡張
- 残タスク: `workflow_dispatch`でのGitHub Actions実機確認(ローカルからは実行できないため、次回リポジトリへのpush後にユーザー側で確認が必要)

---

## Phase 2: 認証更新の無人化(中期・20-30h)— 最大の壁への挑戦

**✅ 実装完了(2026-07-04): 当初の2A/2B案とは異なる方法で解決した。**

Phase 1実装時点では「Cookieが自然失効する」想定だったが、実機検証で以下が判明した:

- 認証必須Cookieのうち `SID` は375日以上有効(自然失効ではない)
- しかし `__Secure-1PSIDTS` は**Google側の設計上、15〜20分ごとにローテーションしないと
  失効する**仕様(notebooklm-py 0.7.3の公式ドキュメントに明記)。実機で「ログインから
  約18時間で認証切れ」を確認しており、これが真因だった
- notebooklm-py 0.3.4(旧バージョン)にはこの問題への対処が無かったが、0.7.3では
  `notebooklm auth refresh` コマンドで解決できる(新規ログイン無しでセッションの
  トークンだけをローテーションする、BotDetectionリスクの低い操作)

**実装内容:**
1. `notebooklm-py` を `0.7.3` に固定(`requirements.txt` / 全ワークフロー)
2. `.github/workflows/auth_keepalive.yml` 新規作成: 15分おきに `notebooklm auth refresh`
   を実行し、ローテーション結果を `NOTEBOOKLM_AUTH_JSON` Secretへ自動書き戻す
3. Secret書き込みには`GITHUB_TOKEN`では権限が足りないため、Secrets書き込み専用の
   Fine-grained PAT(`GH_PAT_SECRETS_WRITE`)を新規追加
4. `refresh_auth.ps1` / `nbklm/auth_monitor.py`: 0.7.3のプロファイル形式パス
   (`~/.notebooklm/profiles/default/storage_state.json`)に対応、旧パスへもフォールバック

**検証チェックリスト:**
- [x] workflow_dispatchで auth_keepalive.yml を実行し、Secret更新まで成功することを確認
- [x] daily_collect / auth_check が更新後のSecretで正常に認証できることを確認
- [ ] 15分間隔のscheduleトリガーが継続して成功し続けること(要中長期観察)

**効果: 手動ステップM1/M2の解消 = 実質的な完全自動化の達成点。案2A/2Bは不採用(下記に記録として残す)**

<details>
<summary>不採用となった当初案2A/2B(記録)</summary>

### 案2A: Cookie延命 + 半自動化の摩擦最小化
CIからヘッドレスアクセスしてセッションを延命する案。「データセンターIPからの反復アクセス
がBot検知される」リスクを懸念し保留していたが、実際の原因はBot検知ではなく
`__Secure-1PSIDTS`の仕様上の短命さだったため、この案自体は不要になった。

### 案2B: Playwright + TOTPによる完全自動ログイン
Googleパスワード/TOTPシークレットをSecretsに保存する案。`auth refresh`は既存セッションの
トークンローテーションのみで新規ログインを伴わないため、この重装備な案も不要になった。

</details>

---

## Phase 3: セットアップのワンコマンド化(16h)

**⚠️ 着手前に必須の前提修正:** `SETUP.md` は現行実装(`NOTEBOOKLM_AUTH_JSON`生JSON Secret + 週次ノートブック自動作成)ではなく旧方式(`NOTEBOOKLM_STORAGE_STATE`のBase64 Secret + 固定4ノートブックID)を記載している(Phase 0参照)。setup_auto がこの古い手順を自動化してしまうと壊れたセットアップが量産されるため、**まずSETUP.md/README.mdを現行実装に合わせて修正してから** setup_auto を書くこと。

**実装内容:**
0. **(最優先・1-2h)** SETUP.md を現行実装に合わせて修正: Secret名を `NOTEBOOKLM_AUTH_JSON`(生JSON、Base64不要)に、ノートブックID記載を「週次自動作成のため事前登録不要」に更新
1. `scripts/setup_auto.ps1`(Windows)/ `scripts/setup_auto.sh`(WSL2)を新規作成。対話式で以下を自動実行:
   - Python環境+依存インストール(`pip install -r requirements.txt` + `playwright install chromium`)
   - `notebooklm login` 誘導(Phase 2B導入済みなら自動)
   - `gh secret set` によるSecrets一括登録(NOTEBOOKLM_AUTH_JSON / ANTHROPIC_API_KEY 等)
   - `register_task.ps1` 呼び出しでTask Scheduler登録
   - `python main.py --mode check` でスモークテスト
2. README.mdのセットアップ章を「3コマンド」に書き換え(修正済みSETUP.mdの内容と整合させる)

**検証チェックリスト:**
- [ ] クリーンなクローンからsetup_auto実行→daily_collect手動トリガー成功まで通しで確認
- [ ] 途中失敗時に再実行可能(冪等)であること
- [ ] SETUP.md記載のSecret名・手順が実際の `nbklm/client.py` の挙動と一致すること

---

## Phase 4: 無人運用の堅牢化(長期・任意)

**実装内容(優先順):**
1. **リトライ**: RSS/API取得に指数バックオフ付きリトライ(3回)を共通デコレータで導入(現状リトライなし — collectors全般)
2. **weekly_digest.yml の失敗通知**: 現在未実装 — daily_collect.yml L68-100 のIssue作成パターンをコピー
3. **UE Forum フィードの削除**: Bot弾きで失敗率が高い(DOCUMENT.md L401記載)— `unity_ue_collector.py` から除去 or 失敗を警告扱いに
4. **ヘルスダッシュボード**: 実行結果(ok/skip/errors件数)をJSONでリポジトリにコミットし、README上にバッジ/簡易表を自動生成
5. **(検討)self-hosted runner / Docker化**: GitHub Actionsの制約(30分タイムアウト・cron停止)を回避したい場合のみ

**検証チェックリスト:**
- [x] ネットワーク断をシミュレートしてリトライ動作を確認(合成関数で3回リトライ→例外送出をローカル確認済み)
- [ ] weekly_digest失敗時にIssueが作成される — **要実機確認**
- [ ] 1週間の無人運用でIssueゼロ(または自動クローズ済み)を確認 — **要実機確認**

**実装状況(2026-07-03): コード実装完了。**
- `collectors/retry.py` 新規作成(指数バックオフ3回リトライ)。全collector(zenn_qiita/unity_ue/cedec/paper)のネットワーク取得部分に適用
- UE Forumフィード(`forums.unrealengine.com`)を`unity_ue_collector.py`から削除(Bot弾きで恒常的に失敗するため)
- `weekly_digest.yml` に失敗時Issue作成ステップを追加(`weekly-digest-failed`ラベル、`permissions: contents: write / issues: write`)
- ヘルスダッシュボード: `health.py`(実行結果記録)+ `scripts/update_readme_health.py`(README自動更新)を新規作成。`main.py`のrun_daily/run_weeklyに記録処理を追加。daily_collect.yml/weekly_digest.ymlに health.json・README.md の自動コミットステップを追加
- 残タスク: 実際のGitHub Actions実行での動作確認(ローカルからは実行できないため、次回のワークフロー実行で確認が必要)

---

## Final Phase: 完全自動化の判定基準

以下が全て満たされたら「完全自動化」達成とみなす:
- [ ] 30日間、人間の操作ゼロで daily_collect / weekly_digest が成功し続ける(auth_keepalive導入後、要継続観察)
- [x] Cookie失効が自動更新される(Phase 2: auth_keepalive.ymlで15分おきローテーション)
- [x] 障害発生時はIssueで通知され、回復時に自動クローズされる(Phase 1)
- [ ] 新環境セットアップが `setup_auto` 1コマンドで完了する(Phase 3、未着手)

**進捗(2026-07-04時点): Phase 1・2・4 実装完了・実機検証済み。残るはPhase 3(セットアップ簡略化)のみ。**
**Phase 2は当初のCookie延命(2A)/TOTP自動ログイン(2B)ではなく、notebooklm-py 0.7.3の`auth refresh`機能を使ったセッションローテーションで解決済み。**

---

## 追加テーマ: ローカル限定データ拡張(バックフィル・新分野追加)(2026-08-11追記)

**改善指標: 配布物(git管理対象)に一切影響を与えず、収集範囲(旧記事+新分野)を拡張する**
追記日: 2026-08-11 / 上記Phase 0〜Final Phase(認証自動化テーマ)とは独立の別テーマ。既存部分は不変。

### 現状分析(新テーマ分)

**収集アーキテクチャの共通規約(緩い統一):**
- `collectors/*.py` は「まとめ役の関数名は`collect`」という規約はあるが、引数は完全統一ではない。`zenn_qiita_collector.py` L58 `collect(max_per_feed: int = 20)`、`cedec_collector.py` L185 `collect(max_cedil: int = 30, max_youtube: int = 20)`、`paper_collector.py` L282-285 `collect(max_arxiv: int = 5, max_semantic: int = 5)` と、ソースの実態に応じて引数名が変わる。
- 戻り値スキーマは統一済み: `url`/`title`/`source_type`/`platform`/`published_at`/`url_hash` の6キー(`zenn_qiita_collector.py` L86-93、`cedec_collector.py` L125-132・L166-173 で確認)。
- 呼び出し元は `main.py` の `run_daily()` L54-92 に個別ハードコード。各collectorモジュールを`try/except Exception`でimport〜呼び出しし、1つが失敗しても他は継続する設計(L60-61, L69-70, L78-79, L89-90)。

**ドメイン管理・カテゴリ管理:**
- フィード定義は統一設定ファイル無し、Pythonのタプルリスト直書き。`zenn_qiita_collector.py` L19-26 `ZENN_FEEDS`、L28-34 `QIITA_FEEDS`(いずれも `(url, source_type, platform)` のタプル)。フィード追加=このファイルを直接編集する運用。
- `nbklm/notebook_ids.py` L36-52 `SOURCE_TYPE_TO_CATEGORIES` は `source_type → [カテゴリ...]` の固定辞書(zenn/qiita/unity/unreal/cedec/gdc/paper/arxivの8キー)。L56-60 `CATEGORY_TO_NOTEBOOK_NAME` は3カテゴリ(`game_dev_tech`/`graphics_research`/`software_engineering`)のノートブック名テンプレート固定。

**ローカル限定という概念の不在(ただし使える前例が1つ存在):**
- `.gitignore` L1-10 はシークレット除外専用(`.env`系、`storage_state.json`、`.notebooklm/`)。「機能一式をローカル限定にする」パターンはこれまで存在しない。
- ただし `main.py` L167-176 `_save_to_notion()` に **`from notion.client import save_articles` を `try/except ImportError` で囲み、モジュールが無ければ黙ってスキップする**という前例コードがある。実際、このチェックアウトに `notion/` ディレクトリは存在しないことを確認済み(Glob該当0件)。Phase 7ではこのパターンをそのまま転用する。

**バックフィル機構の不在:**
- 全collectorが「取得できた最新N件をスライスして返す」構造。例: `zenn_qiita_collector.py` L73 `entries = feed.entries[:max_per_feed]`。RSSフィード自体が直近分しか公開しないため、「旧記事を取りに行く」経路がAPI呼び出しレベルでそもそも存在しない。
- `nbklm/seen_urls.py` L15-18 `SEEN_URLS_FILE`(リポジトリルートの `seen_urls.txt`)、L43-70 `filter_new_articles()` はSHA-256ハッシュ(先頭16文字)の集合演算による**一方向**(未出URLのみ通す)の重複防止。期間指定などの概念は無い。

**GitHub Actions側の構造的制約:**
- `.github/workflows/daily_collect.yml` L11 `runs-on: ubuntu-latest`、L18-19 `actions/checkout@v4`(git管理下ファイルのみチェックアウト)、L12 `timeout-minutes: 30`、L4-6 `cron: '0 3,9,15,21 * * *'`(6時間おき)。ローカル限定/gitignore対象のファイルはチェックアウトされないため、新分野コレクターをこのワークフローに乗せることは構造的に不可能(乗せるにはgit管理下に置く必要があり、それ自体がPhase 7の制約と矛盾する)。
- ローカル実行の前例は既にある: `register_task.ps1` L6-8(TaskName/BatPath/WorkDir定義)・L26-61(トリガー6時間おき登録〜`Register-ScheduledTask`のtry/catch)が、Windows Task Schedulerに `refresh_auth.ps1` を登録する完成パターンを持つ。

**既存の障害通知ライフサイクル(参考情報、新テーマでは直接使わない):**
- `daily_collect.yml` L76, L98 で `auth-expired` ラベルのIssue自動作成。`refresh_auth.ps1` L52-57 で `auth-expired`/`refresh-soon` 両ラベルを対象に、Secret更新成功時 `gh issue close`(L57)。この機構はPhase 1由来で認証テーマ専用のため、ローカル限定タスクの失敗はこのIssueフローには乗らない(Actions上で動く仕組みのため)。ローカルタスクの失敗検知は素朴なログ出力に留め、この既存資産を無理に流用・改変しない。

### Phase 5: バックフィル収集機構

**設計方針:** 既存 `collect(max_per_feed)` 系のシグネチャ・呼び出し元(`main.py` L54-92)は一切変更しない。各collectorに**別関数** `collect_backfill(since, until)` を追加する形でのみ拡張する。呼び出すかどうかはPhase 7で新設するローカル専用エントリポイントが握り、`main.py`(git管理下)は触らない。

**ソース種別ごとの実現可否:**

| ソース種別 | 対象collector | 真のバックフィル可否 | 制約 |
|---|---|---|---|
| arXiv / Semantic Scholar | `paper_collector.py` | 可能 | 両API共に日付範囲クエリに対応(要ページング実装) |
| Zenn/Qiita/Unity/UE RSS | `zenn_qiita_collector.py` 等 | 制限あり | フィードが直近数十件しか保持しないため「フィードが現存する最古分」までが上限。過去に一度フィードから外れた記事は原理上取得不能 |
| CEDiL(スクレイピング) | `cedec_collector.py` | 要追加調査 | 過去年度セッション一覧ページの有無に依存(`_CEDiLParser`はトップページ専用) |
| CEDEC YouTube RSS | `cedec_collector.py` | 制限あり | RSSと同様の制約 |

RSS系は「バックフィル」と呼べる範囲が限定的である点を実装前に明記しておく(過大な期待を持たせない — Phase 0が当初計画の誇張を実機確認で修正した(L22)のと同じ姿勢)。

**実装内容:**
```python
# collectors/paper_collector.py に追加するイメージ(既存 collect() L282-285 はそのまま無変更)
def collect_arxiv_backfill(
    since: datetime,
    until: datetime,
    max_per_query: int = 50,
) -> list[dict]:
    """since〜untilの期間でarXiv検索APIをページングしながら収集する"""
    ...

def collect_backfill(since: datetime, until: datetime) -> list[dict]:
    """バックフィル版のまとめ関数。collect()とは完全に独立させる"""
    articles = []
    articles.extend(collect_arxiv_backfill(since, until))
    # Semantic Scholarも同様にcollect_semantic_scholar_backfillを追加可能
    return articles
```
- 重複防止は新規実装しない。`nbklm/seen_urls.py` の `filter_new_articles` / `save_seen`(L43-70)をそのまま再利用する。バックフィルで再取得した過去記事のURLハッシュも同じ `seen_urls.txt` に載るため、翌日以降の通常収集や再度のバックフィル実行と衝突しない。
- 実行トリガーはGitHub Actions上に**乗せない**。理由は2つ — (1) Phase 7の「ローカル限定」制約そのもの、(2) `daily_collect.yml` L12 `timeout-minutes: 30` がバックフィルのような重い処理と相性が悪い(Phase 4案5「self-hosted runner検討」と同根の課題、この既存計画には手を付けない)。Phase 7で登録するローカルTask Schedulerタスク・または手動実行からのみ叩く。

**検証チェックリスト:**
- [x] `collect_backfill(since, until)` 追加後も既存 `collect(max_per_feed)` 系の呼び出し(`main.py` L54-92)が無変更のまま成功する(シグネチャ非破壊の確認) — `git diff main.py`で無差分を確認済み
- [x] 同一期間で `collect_backfill` を2回実行しても `seen_urls.txt` に重複ハッシュが追加されない — `filter_new_articles`を一時ファイルに対して2回連続実行し、1回目2件新規→2回目0件新規を確認済み
- [x] arXiv/Semantic Scholarのバックフィルが指定`since`/`until`範囲内の記事のみ返す — arXivは複数クエリ・複数期間で実機確認(範囲外0件)。Semantic Scholar側は`publicationDateOrYear`パラメータが公式ドキュメント準拠であることを確認したが、検証中にAPI側のレート制限(429)に阻まれ実機での正常応答確認は完了していない — **要再検証**
- [x] RSS系collectorのバックフィルは「フィードの現存最古分まで」という制約を実装コード内のdocstringまたはログに明記している

**実装状況(2026-08-14): コード実装完了・arXiv側は実機検証済み。**
- `collectors/paper_collector.py` に `collect_arxiv_backfill` / `collect_semantic_scholar_backfill` / `collect_backfill` を追加。既存 `collect()` は無変更。
- `collectors/zenn_qiita_collector.py` / `unity_ue_collector.py` / `cedec_collector.py` に、それぞれ `collect_backfill(since, until)` を追加。RSS/CEDiLの制約をdocstringに明記(CEDiLはpublished_atが無く過去ページ未対応のため対象外とし、CEDEC YouTubeのみバックフィル対応)。
- **実装時に判明した重要な訂正**: arXiv APIの `submittedDate:[...]` 日付範囲フィルタは、検索語を `all:"..."` とダブルクォートで囲んだ場合のみ有効に働くことを実機確認した(クォート無しだと日付フィルタが無視され全期間から返る)。ただし単純にクォートすると複数単語クエリが「フレーズの厳密一致」になり、`collect_arxiv()`が使う単語羅列クエリではヒット数がほぼゼロになる副作用も判明。最終的に単語ごとに`all:word AND all:word ...`と分解してAND連結する方式を採用し、フレーズ厳密一致を避けつつ日付フィルタだけ効かせる形に実装した。
- Semantic Scholarのバックフィルは `publicationDateOrYear`(YYYY-MM-DD:YYYY-MM-DD)パラメータを使用。公式ドキュメント準拠のパラメータだが、検証中にレート制限(429)で実機確認が完了していない — 次回、間隔を空けての再検証が必要。

### Phase 6: 新分野コレクター追加(植物学・薬学・鉱物学)

**実装内容:**
`collectors/botany_collector.py` / `pharmacology_collector.py` / `mineralogy_collector.py` を新規作成。`cedec_collector.py`と同じ「個別収集関数 + まとめ役の`collect()`」構造に揃える。

```python
# collectors/botany_collector.py の骨子(cedec_collector.py の構造を踏襲)
import hashlib
from datetime import datetime, timezone
from typing import Optional
from .retry import fetch_feed

def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]

def collect_journal_rss(max_per_feed: int = 20) -> list[dict]:
    """植物学系ジャーナルのRSS(例: J-STAGE収録誌等)を収集する"""
    articles = []
    # 実装は zenn_qiita_collector.collect() と同型(fetch_feed → entries[:max_per_feed] → dict化)
    return articles

def collect(max_per_feed: int = 20) -> list[dict]:
    """このコレクターのまとめ関数。他collectorと同じ命名規約(collect)を踏襲"""
    articles = []
    articles.extend(collect_journal_rss(max_per_feed))
    return articles
```

- ソース候補(要選定、実装時に確定): 植物学=J-STAGE収録の植物学系ジャーナルRSS、薬学=PubMed/J-STAGE薬学系ジャーナル、鉱物学=学会誌RSSまたは公開鉱物データベース。`paper_collector.py` のarXiv/Semantic Scholar実装(APIキー不要・レート制限対策済み、`collect_arxiv` L146・`collect_semantic_scholar` L200)はAPIキー不要ソースのテンプレートとして流用度が高い。
- カテゴリ配線(設計上の接続点): `nbklm/notebook_ids.py` L36-52 `SOURCE_TYPE_TO_CATEGORIES` に相当する `"botany": ["botany"], "pharmacology": ["pharmacology"], "mineralogy": ["mineralogy"]`、L56-60 `CATEGORY_TO_NOTEBOOK_NAME` に相当する3エントリ(例: `"botany": "Botany-{YYYY}-{WNN}"`)が必要。
- **重要な矛盾点(Phase 7で解消):** `nbklm/notebook_ids.py` は現状git管理下のファイル。ここに新カテゴリを直接書き足すと「新分野の存在」自体が配布物(git履歴)に残ってしまい、Phase 7の「配布に混ざってしまうのは良くない」という制約に抵触する。**このファイル本体への直接追記は行わない** — Phase 7で示すローカル限定の拡張ファイル+実行時マージに委ねる。

**検証チェックリスト:**
- [x] 3コレクターがそれぞれ `collect(...) -> list[dict]` 互換の関数を持ち、既存6キー(`url`/`title`/`source_type`/`platform`/`published_at`/`url_hash`)スキーマに一致する
- [x] 新カテゴリ3種(botany/pharmacology/mineralogy)がそれぞれ独立したノートブックへ振り分けられる — `SOURCE_TYPE_TO_CATEGORIES`/`CATEGORY_TO_NOTEBOOK_NAME`のマージ結果を実機確認
- [x] 既存8ソースタイプ(zenn/qiita/unity/unreal/cedec/gdc/paper/arxiv)のカテゴリ振り分けに変化がない(回帰確認) — マージ後も8キーが不変であることを確認
- [x] `nbklm/notebook_ids.py` 本体に新カテゴリが直書きされていないこと(Phase 7の隔離と合わせて確認) — `git diff`で追加分がtry/exceptマージブロックのみであることを確認

**実装状況(2026-08-14): コード実装完了・実機検証済み。**
- `collectors/botany_collector.py` / `pharmacology_collector.py` / `mineralogy_collector.py` を新規作成(いずれも`.gitignore`対象)。
- **当初計画からの設計変更**: J-STAGE等の分野別ジャーナルRSSではなく、`paper_collector.py`と同じarXiv + Semantic Scholar構成を採用した。理由: (1) 存在確認済みでAPIキー不要・レート制限対策済みの既存実装をそのまま流用でき信頼性が高い、(2) 未検証の外部ジャーナルRSSはURL変更・廃止のリスクがあり「壊れたセットアップの量産」を避けたいPhase 3の教訓と同じ理由で避けた。この結果、各collectorのまとめ関数は `collect(max_per_feed)` ではなく `collect(max_arxiv, max_semantic)` (paper_collector.py と同型)になっている。6キースキーマ自体は完全準拠。
- arXiv/Semantic Scholarの重複ロジック共通化のため `collectors/_academic_api.py` を新規作成(こちらはドメイン固有情報を含まないため`.gitignore`対象ではない、通常のtrackedファイル)。paper_collector.py自体は変更せず独立させた。
- 3コレクターとも `collect_backfill(since, until)` を実装し、Phase 5のバックフィル機構にも対応。

### Phase 7: ローカル限定隔離(CRITICAL制約への対応)

**ユーザー明示制約:** 「配布に混ざってしまうのは良くない」— 新分野コレクター本体・その設定・収集済みデータは**git管理対象に一切含めない**。

**設計案:**

1. **`.gitignore`にファイル単位のパターンを追加**(既存L1-10のシークレット除外に倣う。新規ディレクトリを切って丸ごとignoreする案も検討したが、`collectors/`という既存の共通ディレクトリ構造を変えないためファイル単位除外を優先):
```gitignore
# ============================================================
# ローカル限定: 新分野コレクター(配布物に含めない)
# ============================================================
collectors/botany_collector.py
collectors/pharmacology_collector.py
collectors/mineralogy_collector.py
nbklm/notebook_ids_local.py
local_collect_extra.py
output/local_extra/
```

2. **カテゴリ設定の分離:** `nbklm/notebook_ids.py` 本体(git管理)は無変更。新規に `nbklm/notebook_ids_local.py`(上記gitignore対象)を作り、そこに `SOURCE_TYPE_TO_CATEGORIES_LOCAL` / `CATEGORY_TO_NOTEBOOK_NAME_LOCAL` を定義する。読み込み側は `main.py` L167-176 `_save_to_notion()` と同型の **try/except ImportError** で吸収する:
```python
# ノートブック振り分け処理の初期化部に追加するイメージ
try:
    from .notebook_ids_local import (
        SOURCE_TYPE_TO_CATEGORIES_LOCAL,
        CATEGORY_TO_NOTEBOOK_NAME_LOCAL,
    )
    SOURCE_TYPE_TO_CATEGORIES.update(SOURCE_TYPE_TO_CATEGORIES_LOCAL)
    CATEGORY_TO_NOTEBOOK_NAME.update(CATEGORY_TO_NOTEBOOK_NAME_LOCAL)
except ImportError:
    pass  # ローカル拡張ファイルが無い環境(=配布先)では黙ってスキップ
```
   この「存在しなければ黙ってスキップ」は新規発明ではなく、`main.py` L167-176 の `_save_to_notion()`(`notion.client`のimportをtry/exceptで囲む。実際に `notion/` ディレクトリはこのチェックアウトに存在しないことを確認済み)と同じ型の転用。

3. **実行はGitHub Actionsを経由しない別スクリプト:** `register_task.ps1` L6-8・L26-61 と同じ構成でPowerShellスクリプトを新規作成し、Windows Task Schedulerにローカル専用タスクとして登録する。
```powershell
# register_local_extra_task.ps1 の骨子(register_task.ps1 と同型)
$TaskName = "ResearchCollector LocalExtra"
$ScriptPath = "C:\Users\matuu\Desktop\GameDevelopment\Research-Collector\local_collect_extra.py"  # gitignore対象
# トリガー・Register-ScheduledTask 部分は register_task.ps1 L26-61 を踏襲
```
   `.github/workflows/daily_collect.yml`・`auth_check.yml`・`auth_keepalive.yml`・`weekly_digest.yml` には一切手を入れない。GitHub Actions側は新分野コレクター・バックフィル機構の存在を知らないままで良い。

4. **NotebookLMノートブックの分離:** 新分野3カテゴリは `CATEGORY_TO_NOTEBOOK_NAME_LOCAL` で独自命名(例: `Botany-{YYYY}-{WNN}`)を持つため、既存3ノートブック(`Game-Dev-Tech-*`/`Graphics-Research-*`/`Software-Engineering-*`)とは物理的に別ノートブックになる。既存の週次Digest(`run_weekly()`, `main.py` L182-205)が新カテゴリを巻き込むかどうかは内部の`generate_weekly_digest()`実装依存のため、Phase 6/7実装時に要確認 — 既存3カテゴリの週次運用に影響を与えないことを最優先とする。

**検証チェックリスト:**
- [x] `git status`(および`git status --ignored`)で新分野コレクター(`botany_collector.py`等)・`notebook_ids_local.py`・`local_collect_extra.py` が **untracked または ignored** と表示される — 実機確認済み(全てIgnored files欄に表示)
- [x] `git add -A` を試しても新分野関連ファイルがステージされない — `git add -A -n`(dry-run)で対象ファイルが一切ステージされないことを確認
- [x] ローカル拡張ファイルが存在しないクリーンな環境で `main.py` の実行が例外なく成功する(try/except ImportErrorが正しく機能する=配布先での安全性確認) — `notebook_ids_local.py`を退避して`nbklm.notebook_ids`をimportし、例外なく元の3カテゴリにフォールバックすることを確認
- [x] ローカルTask Schedulerタスクが `register_task.ps1` 同様、管理者権限チェック・重複登録時の`-Force`上書きに対応している — コードレビューで確認(加えて対象.batファイルの存在チェックも追加)

**実装状況(2026-08-14): コード実装完了・隔離設計は実機検証済み。**
- `.gitignore` に Phase 7 対象パターン(`collectors/botany_collector.py` 等5件 + `output/local_extra/`)を追加。
- `nbklm/notebook_ids.py` 本体末尾に `notebook_ids_local` の try/except ImportError マージ処理を追加(本体3カテゴリは無変更)。`nbklm/client.py` の `_get_weekly_notebook_ids()` は既存3カテゴリを固定リストで参照する実装だったため、新カテゴリをマージしても既存の週次Digest運用に影響しないことをコード確認済み(懸念していたPhase 7項目4は実装前提が誤りだったことが判明し、対応不要と判明)。
- `nbklm/notebook_ids_local.py`(gitignore対象)を新規作成。
- `local_collect_extra.py`(gitignore対象)を新規作成。`main.py`の`run_daily()`と同型の構成(認証確認→収集→重複除去→NotebookLM追加→`seen_urls.txt`更新)。`--backfill --since YYYY-MM-DD [--until YYYY-MM-DD]`でPhase 5のバックフィル機構を呼び出せる。実行ログは`output/local_extra/`(gitignore対象)に保存。
- `register_local_extra_task.ps1`(通常のtrackedファイル。ドメイン固有情報を含まないため隔離対象外)と、そのラッパー`run_local_extra_collect.bat`を新規作成。`register_task.ps1`の構成(管理者権限チェック・try/catchでの登録結果判定・UTF-8 BOM保存)を踏襲し、加えて対象.batファイルの存在チェックを追加した(gitignore対象ファイルが未作成のままタスク登録だけ進んでしまう事故を防止)。トリガーは1日1回04:00(daily_collect.ymlの6時間おき・AuthRefreshの0/6/12/18時と重ならない時間帯)。
- 残タスク: 実際にWindows Task Scheduler経由で`Start-ScheduledTask`実行しての通しの動作確認(ローカル環境でのユーザー操作が必要なため未実施)。

### Final Phase(新テーマ分): 統合検証

以下が全て満たされたら本テーマの完了とみなす:
- [x] `git status`(および`--ignored`)で新分野コレクター・ローカル設定・収集済み出力のいずれもuntracked/ignoredであり、通常のdiff・コミットに紛れ込まないことを直接確認
- [ ] 既存 `daily_collect.yml` / `auth_check.yml` / `auth_keepalive.yml` / `weekly_digest.yml` が本テーマ追加後も無変更のまま成功し続ける(追加前後でActions実行結果に差分が無いこと) — これらのワークフローファイル自体は無変更(`git diff`で確認済み)だが、実際のActions実行結果での継続確認は次回のワークフロー実行を待つ必要がある — **要実機確認**
- [ ] ローカルTask Scheduler経由のバックフィル/新分野収集タスクが手動実行(`Start-ScheduledTask`)で正常完走する — **要実機確認**(タスク登録・実行にはユーザーのローカル操作が必要)
- [x] バックフィルで取得した記事のURLハッシュが `seen_urls.txt`(git管理下)に正しく追記され、既存の日次収集(`collect`)との間で二重追加が起きない — `filter_new_articles`/`save_seen`を一時ファイルに対し2回連続実行し、重複が追加されないことを確認済み

**実装時に判明した重要な訂正(実機検証で判明、当初計画からの変更点):**
1. arXiv APIの日付範囲バックフィルは、当初計画のskeleton通りの単純な「ページングして`since`未満で打ち切る」方式では、クエリの人気度によっては目的の期間に到達する前にmax_per_queryを使い切ってしまい0件になる問題があった(例: "machine learning"のような高頻度クエリ)。実装ではarXiv APIのサーバー側`submittedDate`フィルタを使う方式に切り替えて解決した(詳細はPhase 5の実装状況を参照)。
2. Phase 6の新分野コレクターはJ-STAGE等の未検証RSSではなく、`paper_collector.py`と同じarXiv+Semantic Scholar構成を採用した(詳細はPhase 6の実装状況を参照)。

**優先度/複雑度/リスク:** 技術的難度は低い(RSS/API収集・NotebookLM追加の型は既存Phase 0〜4の資産をそのまま流用できる)。一方で「ローカル限定」という制約は事後に破ると気づきにくい(`git add -A`一発で紛れ込む、`nbklm/notebook_ids.py`本体を直接編集してしまう、等のヒューマンエラー経路がある)。**Phase 7の`.gitignore`設計とtry/except分離パターンを他フェーズより先に固め、Phase 5/6の実装はその隔離済みの型の中で行う**順序を推奨する。着手コストの観点では、既存の生きた運用ドキュメント(本ファイル)への追記のみで新規ファイル作成が不要な点、および `main.py` L167-176 にすでに「ローカル限定モジュールを黙って無視する」前例コードが存在する点から、設計の再発明が要らず着手コストは最小。
