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

**🛑 現状判断(2026-07-03): 保留。** Phase 1実装時に実際の`storage_state.json`を調査した結果、
認証必須Cookie(`SID`、`notebooklm.auth.MINIMUM_REQUIRED_COOKIES`)は**既に375日以上**有効なことが判明した。
つまり「Cookieが数週間〜数ヶ月で自然失効する」という当初想定は本ケースでは成立しない可能性が高く、
過去の認証切れの実態は自然失効ではなく、**GitHub Actions等データセンターIPからの反復アクセスに対する
Googleの不正検知によるセッション強制失効**である可能性が高い。

この場合、案2A(CIからヘッドレスアクセスしてセッションを延命する)は前提が崩れており、
むしろ「データセンターIPからの反復アクセス」自体が不正検知のトリガーになり得るため**逆効果のリスク**がある。
案2B(TOTP完全自動ログイン)はBotDetectionリスクが最も高いパターンであり、当面保留とする。

→ **当面はPhase 1の事前検知(Cookie残日数監視)のみで運用し、実際の失効パターン
(自然失効かサーバー側強制失効か)を数週間〜数ヶ月観察してから2A/2Bの要否を再判断する。**
以下は判断が変わった場合の実装案として残す。

**⚠️ 事前判断事項:** Google自動ログインは (a) BotDetectionで弾かれるリスク、(b) アカウント保護観点のリスクがある。実装前に以下の2案を比較し、まず2Aを試すこと。

### 案2A(推奨・低リスク): Cookie延命 + 半自動化の摩擦最小化
1. **セッション延命**: `notebooklm login`時のブラウザプロファイルを永続化し、毎日のauth_check時にヘッドレスでNotebookLMへアクセスして**セッションをリフレッシュ**する(アクセスがあるセッションは失効しにくい)。Playwrightの`storage_state`再保存で実現
2. **ログイン所要時間の最小化**: refresh_auth.ps1 のログインを「ブラウザが開いたら承認1タップ」まで削る(Googleアカウントのスマホプロンプト活用)
3. 実測: 延命により手動ログイン頻度が数ヶ月に1回まで下がれば、実用上の完全自動化とみなせる

### 案2B(2Aで不足時のみ): Playwright + TOTP による完全自動ログイン
1. `auth/google_login_auto.py` 新規作成: Playwright ChromiumでGoogleログインフロー(email→password→TOTP)を自動化
2. TOTPは `pyotp` で生成: `pyotp.TOTP(os.environ["GOOGLE_TOTP_SECRET"]).now()`
3. GitHub Secrets: `GOOGLE_ACCOUNT_EMAIL` / `GOOGLE_ACCOUNT_PASSWORD` / `GOOGLE_TOTP_SECRET`
4. 新ワークフロー `.github/workflows/auto_auth_refresh.yml`: auth_monitorの`needs_refresh`検知時+月1回実行、成功時に`NOTEBOOKLM_AUTH_JSON` Secretを`gh secret set`で自動更新
5. **専用Googleアカウントの使用を強く推奨**(メインアカウントのパスワードをSecretsに置かない)

**検証チェックリスト:**
- [ ] (2A) 延命後のCookie失効日が伸びることをauth_monitorの残日数で確認
- [ ] (2B) workflow_dispatchで auto_auth_refresh.yml を実行し、Secret更新→daily_collect成功まで通し確認
- [ ] 失敗時にIssue作成へフォールバックすること(自動化が壊れても Phase 1 の検知網に落ちる)

**効果: 手動ステップM1/M2の解消 = 実質的な完全自動化の達成点**

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
- [ ] ネットワーク断をシミュレートしてリトライ動作を確認
- [ ] weekly_digest失敗時にIssueが作成される
- [ ] 1週間の無人運用でIssueゼロ(または自動クローズ済み)を確認

---

## Final Phase: 完全自動化の判定基準

以下が全て満たされたら「完全自動化」達成とみなす:
- [ ] 30日間、人間の操作ゼロで daily_collect / weekly_digest が成功し続ける
- [ ] Cookie失効が発生しない(Phase 2Aの延命)か、自動更新される(Phase 2B)
- [ ] 障害発生時はIssueで通知され、回復時に自動クローズされる
- [ ] 新環境セットアップが `setup_auto` 1コマンドで完了する

**推奨実行順: SETUP.md修正(1-2h・Phase 3 item0を先出し) → Phase 1(4-5h) → Phase 2A(数h・検証1ヶ月) → Phase 3残り(14-15h) → Phase 4 →(2Aで不足なら)Phase 2B(20-30h)**
**Phase 1 + 2A だけで実用上の完全自動化に到達できる可能性が高い。2Bはリスク(Bot検知・認証情報管理)があるため最後の手段とする。SETUP.mdの修正は工数が小さく、実装との乖離が新規セットアップ時の実害に直結するため他のどのPhaseよりも先に着手する価値がある。**
