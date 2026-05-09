# GitHub Actions × NotebookLM 自動情報収集システム
## ハンズオン資料

> 作成者: 松浦真聖 (TK230178)  
> 対象: エンジニア系学生  
> 所要時間: 約60〜90分

---

## はじめに

このハンズオンでは、技術記事・CEDEC資料・論文を毎日自動収集してNotebookLMに蓄積するシステムを構築します。一度セットアップすれば、毎日AM6時に自動で動き続けます。

**このシステムで実現できること**

- Zenn/Qiita/Unity/UE/CEDECの新着記事を毎日自動収集
- 卒論テーマに関連する論文を週2回自動収集
- NotebookLMに蓄積してAI検索・ポッドキャスト生成が使える
- 週次まとめレポートを自動生成

---

## 必要なもの

| 必要なもの | 補足 |
|---|---|
| GitHubアカウント | privateリポジトリを作成する |
| Googleアカウント | NotebookLM Plusが必要（月額約2,400円） |
| Python 3.11以上 | Windows環境 |
| WSL2（Ubuntu） | Linux環境でのログインに必要 |
| Anthropic APIキー | https://console.anthropic.com で取得 |

> **なぜWSL2が必要か？**  
> `notebooklm-py` のCookieはLinux環境で取得する必要があります。  
> GitHub Actions（Ubuntu）と同じ環境でログインすることで認証が通ります。

---

## ハンズオン手順

### Step 0: リポジトリのクローン

```bash
# 【Windows PowerShell】
# GitHubでprivateリポジトリを作成後
git clone https://github.com/あなたのユーザー名/research-collector.git
cd research-collector
```

配置するファイル構成は以下の通りです。

```
research-collector/
├── .github/workflows/
│   ├── daily_collect.yml
│   └── weekly_digest.yml
├── collectors/
│   ├── zenn_qiita_collector.py
│   ├── unity_ue_collector.py
│   ├── cedec_collector.py
│   └── paper_collector.py
├── nbklm/
│   ├── __init__.py
│   ├── client.py
│   ├── notebook_ids.py
│   └── seen_urls.py
├── .env
├── .gitignore
├── main.py
└── requirements.txt
```

---

### Step 1: 依存ライブラリのインストール

```powershell
# 【Windows PowerShell】
pip install feedparser requests python-dotenv
pip install "notebooklm-py[browser]"
playwright install chromium
```

---

### Step 2: NotebookLMへのログイン（WSL2で実施）

> ⚠️ **必ずWSL2（Linux）で実行してください。**  
> WindowsのChromeで取得したCookieはGitHub Actions（Linux）では動きません。

```bash
# 【WSL2】
pip install "notebooklm-py[browser]"
playwright install chromium
notebooklm login
# ブラウザが開いたらGoogleにログインしてENTERを押す
```

ログインが成功すると `~/.notebooklm/storage_state.json` が生成されます。

---

### Step 3: NotebookLMノートブックの作成

週次ノートブックは自動作成されますが、固定ノートブックは手動で作成します。

```bash
# 【WSL2】
notebooklm create "Weekly-Digest"
# 表示されたIDをメモしておく
```

表示されたIDを `nbklm/notebook_ids.py` の `NOTEBOOK_IDS_FIXED` に記入します。

```python
NOTEBOOK_IDS_FIXED = {
    "weekly_digest": "ここにIDを貼り付ける",
}
```

---

### Step 4: GitHub Secretsの登録

**① storage_state.json を1行JSONに圧縮してコピー**

```bash
# 【WSL2】
cat ~/.notebooklm/storage_state.json | python3 -c \
  "import sys,json; print(json.dumps(json.load(sys.stdin)))"
# 出力された1行の文字列をコピー
```

**② GitHub Secretsに登録**

`https://github.com/あなたのユーザー名/research-collector/settings/secrets/actions`

| Secret名 | 内容 |
|---|---|
| `NOTEBOOKLM_AUTH_JSON` | 上記コマンドの出力（1行JSON） |
| `ANTHROPIC_API_KEY` | `sk-ant-...` で始まるAPIキー |

**③ ローカル用 `.env` ファイルの作成**

```powershell
# 【Windows】.env.exampleをコピーして編集
copy .env.example .env
notepad .env
```

```
ANTHROPIC_API_KEY=sk-ant-...
NOTION_TOKEN=ntn_...（任意）
```

---

### Step 5: ローカルで動作確認

```powershell
# 【Windows PowerShell】

# 認証確認
python main.py --mode check
# → [INFO] auth OK (7 notebooks) が出ればOK

# 収集テスト
python main.py --mode daily
# → [INFO] === Daily Collect Done === が出ればOK
```

出力例：
```
2026-05-09 11:51:22 [INFO] === Daily Collect Start ===
2026-05-09 11:51:23 [INFO] [NotebookLM] auth OK (7 notebooks)
2026-05-09 11:51:24 [INFO] Zenn/Qiita: 52 articles
2026-05-09 11:51:24 [INFO] Unity/UE: 18 articles
2026-05-09 11:51:24 [INFO] CEDEC: 23 items
2026-05-09 11:51:24 [INFO] Papers: skipped (runs Mon/Thu only)
2026-05-09 11:51:24 [INFO] After in-run dedup: 89 articles
2026-05-09 11:51:24 [INFO] [seen_urls] 89 new, 0 already seen
2026-05-09 11:51:45 [INFO] NotebookLM: ok=134, skip=12, errors=12
2026-05-09 11:51:45 [INFO] [seen_urls] saved 89 hashes
2026-05-09 11:51:45 [INFO] === Daily Collect Done ===
```

---

### Step 6: GitHubにpushして自動実行を有効化

```powershell
# 【Windows PowerShell】
git add .
git commit -m "initial setup"
git push origin main
```

**GitHub Actionsで手動テスト**

`Actions` タブ → `Daily Research Collect` → `Run workflow`

ログに `Daily Collect Done` が出てNotebookLMにノートブックが追加されていれば完成です！

---

## 重複チェックの仕組み

同じ記事を毎日追加しないように `seen_urls.txt` でURLを管理しています。

```
収集したURL
  → SHA256でハッシュ化（先頭16文字）
  → seen_urls.txt と照合
  → 新規のみNotebookLMへ追加
  → seen_urls.txt を更新してgit commit（永続化）
```

GitHub Actionsが実行するたびに自動でコミットされるため、手動操作は不要です。

---

## NotebookLMの活用方法

### 週次ノートブックでチャット

```
Game-Dev-Tech-2026-W20 を開いて…

Q: 今週のUnityの注目アップデートを教えて
Q: DirectX12に関する記事をまとめて
Q: Houdiniの新機能は何がある？
```

### Audio Overviewで耳から学ぶ

ノートブックを開いて「Audio Overview」を生成すると、2人のAIが対談するポッドキャスト形式の音声が生成されます。通勤・移動中に技術トレンドをインプットできます。

### 論文ノートブックで学習コンテンツを生成

`Software-Engineering-2026-W20` を開いて：

- **クイズ生成** → 論文内容の理解度チェック
- **フラッシュカード** → 重要用語の暗記
- **Study Guide** → 卒論の参考文献整理

### Weekly-Digestで週次レポートを確認

毎週月曜AM7時に自動生成されます。Actionsの `Artifacts` からMarkdownファイルをダウンロードして確認できます。

---

## 応用アイデア

### ① 卒論テーマに合わせてカスタマイズ

`collectors/paper_collector.py` の検索クエリを自分の研究テーマに変更します。

```python
# 例：Houdini/RAG/MCPの卒論テーマに合わせる
ARXIV_QUERIES = [
    "retrieval augmented generation DCC tools",
    "LLM tutorial generation Houdini",
    "model context protocol tool automation",
    "procedural generation learning system",
]
```

### ② 就活ターゲット企業の情報を追加

```python
# collectors/zenn_qiita_collector.py に追加
COMPANY_FEEDS = [
    ("https://tech.なんとか会社.co.jp/feed", "unity", "company_blog"),
    ("https://engineering.なんとか会社.com/rss", "unity", "company_blog"),
]
```

### ③ connpassの勉強会情報を追加

```python
# collectors/ に新しいコレクターを作成
CONNPASS_FEEDS = [
    "https://connpass.com/explore/ja/happening/tag/unity/rss/",
    "https://connpass.com/explore/ja/happening/tag/gamedev/rss/",
]
```

### ④ Notionと連携してダッシュボード管理

`notion/client.py` を実装してNotionのDBに収集記事を保存すると、Notionで記事一覧・タグ管理・優先度付けができます。

---

## セキュリティ上の注意

| ルール | 理由 |
|---|---|
| リポジトリは必ず `private` に設定 | Cookieや収集URLが外部に漏れるのを防ぐ |
| `.gitignore` に `storage_state.json` と `.env` を追加 | Google認証情報の漏洩防止 |
| `NOTEBOOKLM_AUTH_JSON` はGitHub Secretsのみで管理 | コード内にべた書きしない |
| Cookieが切れたらWSL2で再ログイン | 数週間〜数ヶ月で失効する |

---

## トラブルシューティング

### Q: auth FAILEDが出る

```bash
# 【WSL2】でCookieを再取得
notebooklm login

# storage_state.json を圧縮してSecretを更新
cat ~/.notebooklm/storage_state.json | python3 -c \
  "import sys,json; print(json.dumps(json.load(sys.stdin)))"
```

### Q: `All articles already seen.` と表示される

正常動作です。前回と同じ記事しか収集されなかった場合に表示されます。

### Q: NotebookLMへの追加でskipが多い

フォーラム系URL（`forums.unrealengine.com`等）はBot弾きで失敗します。  
`unity_ue_collector.py` から `UNREAL_FEEDS` のフォーラムURLを削除すると改善します。

### Q: GitHub Actionsのcronが止まった

60日間アクティビティがないと自動停止します。  
`seen_urls.txt` の自動コミットがアクティビティとして認識されるため通常は止まりません。

---

## コマンドまとめ

```bash
# ローカル実行
python main.py --mode check    # 認証確認
python main.py --mode daily    # デイリー収集
python main.py --mode weekly   # 週次Digest生成

# notebooklm CLI
notebooklm list                     # ノートブック一覧
notebooklm login                    # 再ログイン
notebooklm create "ノートブック名"   # ノートブック作成

# seen_urls.txt をリセット（ノートブック作り直し時）
del seen_urls.txt  # Windows
rm seen_urls.txt   # WSL2/Linux
git add seen_urls.txt
git commit -m "chore: reset seen_urls.txt"
git push
```

---

## まとめ

一度セットアップすれば毎日AM6時に自動で動き続けます。NotebookLMを外部脳として活用することで、トークン消費ゼロで大量の資料をAI検索できます。収集ソースとキーワードを変えれば自分のテーマに完全カスタマイズ可能です。コードはすべてGitHubで管理されているので自由に改変して使ってください。

---

*GitHubリポジトリ: `manato1201/research-collector`（private）*
