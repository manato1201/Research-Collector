# 🔬 Research Collector

> **GitHub Actions × NotebookLM による技術情報自動収集システム**  
> 一度セットアップすれば毎日AM6時に自動で動き続けます。

---

## 何ができるの？

| 機能 | 内容 |
|---|---|
| 📰 毎日自動収集 | Zenn/Qiita/Unity/UE/CEDECの新着記事をRSS経由で収集 |
| 📄 論文収集 | arXiv・Semantic Scholarから関連論文を週2回（月・木）収集 |
| 🔁 重複チェック | 収集済みURLを管理し再追加を防止 |
| 📚 NotebookLM自動追加 | 週次ノートブックへ自動振り分け・追加 |
| 📋 週次レポート生成 | 収集内容からカテゴリ別日本語まとめレポートを自動生成 |
| 🔐 認証切れ通知 | 認証切れ時にGitHub Issueを自動作成してメール通知 |

---

## 収集ソース

| ソース | 追加先ノートブック |
|---|---|
| Zenn / Qiita（unity/unrealengine/directx/hlsl/gamedev/houdini） | Game-Dev-Tech |
| Unity / UE 公式ブログ | Game-Dev-Tech + Graphics-Research |
| CEDiL新着セッション / CEDEC YouTube | Graphics-Research + Software-Engineering |
| arXiv / Semantic Scholar（RAG・LLM・DCC学習関連） | Software-Engineering |

---

## セットアップ（所要時間: 約30分）

### 必要なもの

| 必要なもの | 備考 |
|---|---|
| GitHubアカウント | privateリポジトリを推奨 |
| Googleアカウント | NotebookLM Plus推奨（300件/ノートブック） |
| Python 3.11以上 | Windows環境 |
| GitHub CLI（gh） | https://cli.github.com/ からインストール |

### Step 1: このリポジトリをテンプレートから作成

画面上部の「**Use this template**」→「**Create a new repository**」をクリックして自分のリポジトリを作成してください。

> ⚠️ `private` に設定することを強く推奨します

### Step 2: NotebookLMのノートブックを作成

```powershell
# 【Windows PowerShell】
pip install "notebooklm-py[browser]"
playwright install chromium
notebooklm login   # ブラウザでGoogleにログイン → ENTER

# Weekly-Digestノートブックを作成
notebooklm create "Weekly-Digest"
# → 表示されたIDをメモしておく
```

### Step 3: notebook_ids.py を編集

`nbklm/notebook_ids.py` の `NOTEBOOK_IDS_FIXED` に Step 2 で作成したIDを入力してください。

```python
NOTEBOOK_IDS_FIXED = {
    "weekly_digest": "ここにWeekly-DigestのIDを貼り付ける",  # ← 変更
}
```

論文収集のキーワードは `collectors/paper_collector.py` の `ARXIV_QUERIES` / `SEMANTIC_SCHOLAR_QUERIES` を自分の研究テーマに合わせて変更できます。

### Step 4: GitHub Secretsを登録

`https://github.com/あなたのユーザー名/リポジトリ名/settings/secrets/actions`

以下の3つのSecretを登録してください。

| Secret名 | 内容 | 取得方法 |
|---|---|---|
| `NOTEBOOKLM_AUTH_JSON` | NotebookLM認証JSON | Step 5で取得 |
| `NOTEBOOKLM_WEEKLY_DIGEST_ID` | Weekly-DigestのノートブックID | Step 2でメモしたID |
| `ANTHROPIC_API_KEY` | Anthropic APIキー | https://console.anthropic.com |

### Step 5: 認証JSONを取得してSecretに登録

```powershell
# 【Windows PowerShell】
# notebooklm login 後に実行
$json = (Get-Content "$env:USERPROFILE\.notebooklm\storage_state.json" -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10)
$json | gh secret set NOTEBOOKLM_AUTH_JSON --repo あなたのユーザー名/リポジトリ名
```

> GitHub CLIがない場合: https://cli.github.com/ からインストール後 `gh auth login`

### Step 6: auth-expired ラベルを作成

```
https://github.com/あなたのユーザー名/リポジトリ名/labels
→ 「New label」→ 名前: auth-expired、色: #e11d48
```

認証切れ時にこのラベルのIssueが自動作成されます。

### Step 7: 動作確認

```powershell
pip install feedparser requests python-dotenv notebooklm-py
python main.py --mode check   # 認証確認
python main.py --mode daily   # 収集テスト
```

### Step 8: GitHub Actions で自動実行を確認

Actions タブ → `Daily Research Collect` → `Run workflow` で手動実行してテスト。

✅ NotebookLMに `Game-Dev-Tech-YYYY-WNN` などのノートブックが作成されれば完成です！

---

## 自動実行スケジュール

| ワークフロー | タイミング | 内容 |
|---|---|---|
| Daily Research Collect | 毎日 AM 6:00 JST | 記事収集 → NotebookLM追加 |
| Weekly Research Digest | 毎週月曜 AM 7:00 JST | 週次レポート生成（日本語） |
| Weekly Auth Check | 毎週日曜 AM 5:00 JST | 認証切れチェック → メール通知 |

---

## NotebookLMの活用方法

収集された記事は週次ノートブック（例: `Game-Dev-Tech-2026-W20`）に自動追加されます。

```
✅ チャットで質問する
   「今週のUnityアップデートの要点は？」
   「DirectX12の注目記事をまとめて」

✅ Audio Overview で耳から学ぶ
   通勤中に今週の技術トレンドをポッドキャスト形式で聴ける

✅ 週次レポートを確認する（日本語）
   毎週月曜に自動生成
   → Actions → 該当のWeekly Research Digest → Artifacts → weekly-digest-XX
```

---

## 認証が切れた場合

GoogleのCookieは数週間で失効します。GitHub Issueで通知が来たら：

```powershell
# 【Windows PowerShell】リポジトリのフォルダで実行
.\refresh_auth.ps1
```

スクリプトが自動で：
1. ブラウザでGoogleにログイン
2. GitHub Secretsを更新
3. auth-expired Issueをクローズ

---

## カスタマイズ

### 収集するタグ・キーワードを変更

```python
# collectors/zenn_qiita_collector.py
ZENN_FEEDS = [
    ("https://zenn.dev/topics/unity/feed", "unity", "zenn"),
    # ← 自分の興味のあるタグを追加
]

# collectors/paper_collector.py
ARXIV_QUERIES = [
    "retrieval augmented generation tutorial generation",
    # ← 自分の研究テーマに合わせて変更
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
│   ├── weekly_digest.yml      # 毎週月曜 AM 7:00 JST
│   └── auth_check.yml         # 毎週日曜 AM 5:00 JST
├── collectors/
│   ├── zenn_qiita_collector.py
│   ├── unity_ue_collector.py
│   ├── cedec_collector.py
│   └── paper_collector.py
├── nbklm/
│   ├── client.py              # NotebookLM操作ラッパー
│   ├── notebook_ids.py        # ← ここを編集してセットアップ
│   └── seen_urls.py           # 重複チェック管理
├── main.py
├── requirements.txt
├── refresh_auth.ps1           # 認証更新スクリプト（Windows PowerShell用）
├── refresh_auth.sh            # 認証更新スクリプト（WSL2/Linux用）
├── DOCUMENT.md                # 詳細システム設計書
└── HANDSON.md                 # ハンズオン資料
```

---

## 容量設計（NotebookLM Plus）

| 指標 | 数値 |
|---|---|
| 1ノートブックのソース上限 | 300件 |
| 週次消費ノートブック数 | 3冊（カテゴリ×1） |
| 週あたり新規収集件数 | 約50〜150件 |
| 年間消費ノートブック数 | 約156冊 |
| ノートブック上限（Plusプラン） | 500冊 |
| **持続可能期間** | **約3年** |

---

## ライセンス

MIT License — 自由に改変・再配布して使ってください。

---

*Created by 松浦真聖 *
