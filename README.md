# Research Collector

**GitHub Actions x NotebookLM による技術情報自動収集システム**

一度セットアップすれば毎日AM6時に自動で動き続けます。

---

## 何ができるの？

| 機能 | 内容 |
|---|---|
| 毎日自動収集 | Zenn/Qiita/Unity/UE/CEDECの新着記事をRSS経由で収集 |
| 論文収集 | arXiv・Semantic Scholarから関連論文を週2回（月・木）収集 |
| 重複チェック | 収集済みURLを管理し再追加を防止 |
| NotebookLM自動追加 | 週次ノートブックへ自動振り分け・追加 |
| 週次レポート生成 | 収集内容からカテゴリ別日本語まとめレポートを自動生成 |
| 認証自動更新 | Windowsタスクスケジューラで毎日AM5:30に認証を自動更新 |

---

## 収集ソース

| ソース | 追加先ノートブック |
|---|---|
| Zenn / Qiita（unity/unrealengine/directx/hlsl/gamedev/houdini） | Game-Dev-Tech |
| Unity / UE 公式ブログ | Game-Dev-Tech + Graphics-Research |
| CEDiL新着セッション / CEDEC YouTube | Graphics-Research + Software-Engineering |
| arXiv / Semantic Scholar（RAG・LLM・DCC学習関連） | Software-Engineering |

---

## 自動実行スケジュール

| タイミング | 実行内容 | 実行環境 |
|---|---|---|
| 15分おき | セッションCookie(`__Secure-1PSIDTS`)のキープアライブ | GitHub Actions |
| 毎日 AM 5:30 | NotebookLM認証更新（保険） | Windowsタスクスケジューラ |
| 毎日 AM 6:00 | 記事収集 → NotebookLM追加 | GitHub Actions |
| 2日に1回 AM 7:00 | レポート生成（日本語） | GitHub Actions |
| 毎週日曜 AM 5:00 | 認証切れ事前検知・チェック → Issue通知 | GitHub Actions |

---

## 運用ステータス

<!-- HEALTH_START -->
| 実行 | 最終実行 | 詳細 |
|---|---|---|
| Daily Collect | ✅ 2026-07-20T00:41:25Z | 収集107件 / 新規2件 / NotebookLM追加4件 |
| Weekly Digest | ✅ 2026-07-20T01:01:31Z | 5735文字生成 |
<!-- HEALTH_END -->

*daily_collect / weekly_digest 実行のたびに自動更新されます。*

---

## セットアップ（所要時間: 約45分）

### 必要なもの

| 必要なもの | 備考 |
|---|---|
| GitHubアカウント | privateリポジトリを推奨 |
| Googleアカウント | NotebookLM Plus推奨（300件/ノートブック） |
| Python 3.11以上 | Windows環境 |
| GitHub CLI（gh） | https://cli.github.com/ からインストール |

### Step 1: このリポジトリをテンプレートから作成

「**Use this template**」→「**Create a new repository**」をクリック。

> ⚠️ `private` に設定することを強く推奨します

### Step 2: NotebookLMのノートブックを作成

```powershell
pip install "notebooklm-py[browser]==0.7.3"
playwright install chromium
notebooklm login
notebooklm create "Weekly-Digest"
# → 表示されたIDをメモ
```

### Step 3: notebook_ids.py を編集

`nbklm/notebook_ids.py` の `NOTEBOOK_IDS_FIXED` にStep 2のIDを入力。

```python
NOTEBOOK_IDS_FIXED = {
    "weekly_digest": "ここにWeekly-DigestのIDを貼り付ける",
}
```

### Step 4: GitHub Secretsを登録

```powershell
# 認証JSONを取得してSecretに登録
notebooklm login
$json = (Get-Content "$env:USERPROFILE\.notebooklm\profiles\default\storage_state.json" -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10)
$json | gh secret set NOTEBOOKLM_AUTH_JSON --repo あなたのユーザー名/リポジトリ名
```

| Secret名 | 内容 |
|---|---|
| `NOTEBOOKLM_AUTH_JSON` | 上記コマンドで登録 |
| `NOTEBOOKLM_WEEKLY_DIGEST_ID` | Step 2でメモしたID |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com で取得 |
| `GH_PAT_SECRETS_WRITE` | Secrets書き込み権限のみのFine-grained PAT(`auth_keepalive.yml`用。SETUP.md参照) |

### Step 5: auth-expired ラベルを作成

```
https://github.com/あなたのユーザー名/リポジトリ名/labels
→ New label → 名前: auth-expired、色: #e11d48
```

### Step 6: Workflow permissions を変更

```
リポジトリ Settings → Actions → General
→ Workflow permissions → Read and write permissions → Save
```

### Step 7: タスクスケジューラに登録（認証自動更新）

```powershell
# リポジトリのフォルダで実行
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"C:\Users\あなたのユーザー名\path\to\run_auth_refresh.bat`""
$trigger = New-ScheduledTaskTrigger -Daily -At "05:30"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "NotebookLM AuthRefresh" -Trigger $trigger -Action $action -Settings $settings -Force
```

### Step 8: 動作確認

```powershell
python main.py --mode check   # 認証確認
python main.py --mode daily   # 収集テスト
```

Actions タブ → `Daily Research Collect` → `Run workflow` で手動実行してテスト。

---

## 認証の仕組み

NotebookLMの認証Cookieには失効パターンが2種類あります。

```
15分おき（GitHub Actions: auth_keepalive.yml）
  → notebooklm auth refresh でセッションをローテーション
  → __Secure-1PSIDTS（15〜20分で失効する設計）を更新し続ける
  → 結果をNOTEBOOKLM_AUTH_JSON Secretへ自動書き戻し
  → これにより「アカウント全体としては数百日単位で有効なSID」を
    実際に使い続けられる状態を維持する

毎日 AM 5:30（Windowsタスクスケジューラ・保険）
  → run_auth_refresh.bat が起動
  → PowerShellウィンドウが開く
  → notebooklm login（ブラウザが開く）
  → Googleにログイン → ENTER（約1分）
  → GitHub Secretsを自動更新
  → 曜日に応じたワークフローを自動再実行
  → ウィンドウが閉じる

AM 6:00（GitHub Actions）
  → 更新済みのCookieで認証OK
  → 記事収集 → NotebookLMに追加
```

### 認証切れになった場合

タスクスケジューラが動いていなかった等で認証が切れた場合は手動で実行してください。

```powershell
# リポジトリのフォルダで実行
powershell.exe -ExecutionPolicy Bypass -File ".\refresh_auth.ps1"
```

---

## NotebookLMの活用方法

```
週次ノートブック（例: Game-Dev-Tech-2026-W20）を開いて

チャットで質問する
  「今週のUnityアップデートの要点は？」
  「DirectX12の注目記事をまとめて」

Audio Overviewで耳から学ぶ
  通勤中に今週の技術トレンドをポッドキャスト形式で聴ける

週次レポートを確認する（日本語）
  2日に1回自動生成
  Actions → Weekly Research Digest → Artifacts → weekly-digest-XX
```

---

## カスタマイズ

### 収集するタグ・キーワードを変更

```python
# collectors/zenn_qiita_collector.py
ZENN_FEEDS = [
    ("https://zenn.dev/topics/unity/feed", "unity", "zenn"),
    # 自分の興味のあるタグを追加
]

# collectors/paper_collector.py
ARXIV_QUERIES = [
    "retrieval augmented generation tutorial generation",
    # 自分の研究テーマに合わせて変更
]
```

### 就活ターゲット企業のブログを追加

```python
# collectors/zenn_qiita_collector.py に追加
COMPANY_FEEDS = [
    ("https://tech.yourcompany.co.jp/feed", "unity", "company_blog"),
]
```

---

## ファイル構成

```
research-collector/
├── .github/workflows/
│   ├── daily_collect.yml      # 毎日 AM 6:00 JST
│   ├── weekly_digest.yml      # 2日に1回 AM 7:00 JST
│   ├── auth_check.yml         # 毎週日曜 AM 5:00 JST
│   └── auth_keepalive.yml     # 15分おき
├── collectors/
│   ├── zenn_qiita_collector.py
│   ├── unity_ue_collector.py
│   ├── cedec_collector.py
│   └── paper_collector.py
├── nbklm/
│   ├── client.py
│   ├── notebook_ids.py        # ← セットアップ時に編集
│   ├── seen_urls.py
│   └── auth_monitor.py        # Cookie残日数の事前検知
├── scripts/
│   └── update_readme_health.py # health.json → README運用ステータス表を更新
├── main.py
├── health.py                  # 実行結果を health.json に記録
├── requirements.txt
├── refresh_auth.ps1           # 認証更新スクリプト（PowerShell）
├── run_auth_refresh.bat       # タスクスケジューラ起動用バッチ
├── register_task.ps1          # タスクスケジューラ登録スクリプト
├── DOCUMENT.md                # 詳細システム設計書
└── HANDSON.md                 # ハンズオン資料
```

---

## 容量設計（NotebookLM Plus）

| 指標 | 数値 |
|---|---|
| 1ノートブックのソース上限 | 300件 |
| 週次消費ノートブック数 | 3冊 |
| 週あたり新規収集件数 | 約50〜150件 |
| 年間消費ノートブック数 | 約156冊 |
| ノートブック上限（Plus） | 500冊 |
| 自動削除の閾値 | 480冊（`nbklm/notebook_cleanup.py`の`MAX_NOTEBOOKS`） |

480冊を超えると、daily_collectの実行時に最も古い週次ノートブックから自動的に削除され、
上限に達することなく運用し続けられる（`Weekly-Digest`等の固定ノートブックは保護され削除されない）。

---

## ライセンス

MIT License

---

*Created by 松浦真聖 *
