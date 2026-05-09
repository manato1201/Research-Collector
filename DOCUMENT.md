# research-collector ドキュメント

> 作成日: 2026-05-09  
> 対象リポジトリ: `manato1201/research-collector`  
> 作成者: 松浦真聖 (TK230178)

---

## 目次

1. [システム概要](#1-システム概要)
2. [システム構成図](#2-システム構成図)
3. [収集ソース一覧](#3-収集ソース一覧)
4. [NotebookLM ノートブック設計](#4-notebooklm-ノートブック設計)
5. [セットアップ手順](#5-セットアップ手順)
6. [ファイル構成](#6-ファイル構成)
7. [運用マニュアル](#7-運用マニュアル)
8. [トラブルシューティング](#8-トラブルシューティング)

---

## 1. システム概要

### 目的

卒業研究・ゲーム開発・技術学習に必要な情報（技術記事・CEDEC資料・論文）を自動収集し、NotebookLMに蓄積することで、AI検索・ポッドキャスト生成・週次まとめレポートを活用できる知識ベースを構築する。

### 主な機能

| 機能 | 内容 |
|---|---|
| 毎日自動収集 | Zenn/Qiita/Unity/UE/CEDECの新着記事をRSS経由で収集 |
| 週2回論文収集 | arXiv・Semantic Scholarから関連論文を収集（月・木） |
| 重複チェック | 収集済みURLをハッシュ管理し、再追加を防止 |
| NotebookLM自動追加 | 週次ノートブックへ自動振り分け・追加 |
| 週次Digest生成 | Deep Researchで調査レポートを自動生成 |

### 技術スタック

| 要素 | 技術 |
|---|---|
| 実行環境 | GitHub Actions（Ubuntu Latest） |
| 言語 | Python 3.11 |
| NotebookLM操作 | notebooklm-py（非公式APIライブラリ） |
| RSS収集 | feedparser |
| スケジューラ | GitHub Actions cron |
| 認証管理 | GitHub Secrets |

---

## 2. システム構成図

```
┌─────────────────────────────────────────────────────┐
│                  GitHub Actions                      │
│  毎日 AM 6:00 JST / 毎週月曜 AM 7:00 JST             │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                   main.py                            │
│                                                      │
│  1. NotebookLM 認証チェック                           │
│  2. 各コレクターで記事収集                             │
│  3. 同一実行内の重複除去                              │
│  4. seen_urls.txt で過去分との重複チェック             │
│  5. NotebookLM 週次ノートブックへ追加                  │
│  6. seen_urls.txt 更新・コミット                      │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   Zenn/Qiita    Unity/UE Blog   CEDEC
   RSS収集        RSS収集        CEDiL + YouTube
          │            │            │
          └────────────┼────────────┘
                       │ 月・木のみ
                       ▼
                  論文収集
              arXiv + Semantic Scholar
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                  NotebookLM                          │
│                                                      │
│  Game-Dev-Tech-2026-W20      ← Zenn/Qiita/Unity/UE  │
│  Graphics-Research-2026-W20  ← Unity/UE/CEDEC        │
│  Software-Engineering-2026-W20 ← CEDEC/論文          │
│  Weekly-Digest（固定）        ← 週次レポート           │
└─────────────────────────────────────────────────────┘
```

---

## 3. 収集ソース一覧

### Zenn（タグ別RSS）

| タグ | URL |
|---|---|
| unity | `https://zenn.dev/topics/unity/feed` |
| unrealengine | `https://zenn.dev/topics/unrealengine/feed` |
| directx | `https://zenn.dev/topics/directx/feed` |
| hlsl | `https://zenn.dev/topics/hlsl/feed` |
| gamedev | `https://zenn.dev/topics/gamedev/feed` |
| houdini | `https://zenn.dev/topics/houdini/feed` |

### Qiita（タグ別RSS）

| タグ | URL |
|---|---|
| unity | `https://qiita.com/tags/unity/feed` |
| unrealengine | `https://qiita.com/tags/unrealengine/feed` |
| directx12 | `https://qiita.com/tags/directx12/feed` |
| hlsl | `https://qiita.com/tags/hlsl/feed` |
| gamedev | `https://qiita.com/tags/gamedev/feed` |

### Unity / Unreal Engine 公式

| ソース | URL |
|---|---|
| Unity Blog | `https://blog.unity.com/feed` |
| Unity Releases | `https://unity.com/releases/lts-vs-tech-stream/feed` |
| UE Blog | `https://www.unrealengine.com/en-US/rss` |
| UE Forum | `https://forums.unrealengine.com/latest.rss` |

### CEDEC

| ソース | 内容 |
|---|---|
| CEDiL | `https://cedil.cesa.or.jp/` のトップページから新着セッションタイトル＋URLを収集（ログイン不要・タイトルのみ） |
| CEDEC YouTube | チャンネルID `UCmHaPXvwn9_4pMNAV6ewgoA` のRSS |

### 論文（月・木のみ実行）

**arXiv 検索クエリ（8件）**
- retrieval augmented generation tutorial generation
- LLM step by step instruction generation
- conversational agent learning assistance
- chatbot technical documentation question answering
- video tutorial learning behavior software
- developer documentation usage behavior
- software documentation maintenance outdated
- tutorial obsolescence software update

**Semantic Scholar 検索クエリ（9件）**
- developer documentation usage behavior
- video tutorial software learning
- how developers learn new tools
- tutorial maintenance technical debt
- software documentation outdated obsolete
- RAG retrieval augmented generation documentation
- LLM tutorial generation step by step
- DCC tool learning curve creative software
- Houdini procedural generation learning

---

## 4. NotebookLM ノートブック設計

### 週次ノートブック（自動作成）

毎週自動的に新しいノートブックが作成されます。

| カテゴリ | ノートブック名の例 | 格納ソース |
|---|---|---|
| Game-Dev-Tech | `Game-Dev-Tech-2026-W20` | Zenn/Qiita/Unity/UE |
| Graphics-Research | `Graphics-Research-2026-W20` | Unity/UE/CEDEC |
| Software-Engineering | `Software-Engineering-2026-W20` | CEDEC/論文 |

### 固定ノートブック

| ノートブック名 | ID | 用途 |
|---|---|---|
| Weekly-Digest | `0942eb24-05f7-45e5-a3d9-1f67e1c5ca0a` | 週次まとめレポート |

### ソース振り分けルール

| source_type | Game-Dev-Tech | Graphics-Research | Software-Engineering |
|---|---|---|---|
| zenn / qiita | ✅ | | |
| unity / unreal | ✅ | ✅ | |
| cedec / gdc | | ✅ | ✅ |
| paper / arxiv | | | ✅ |

### 容量試算（NotebookLM Plus）

| 指標 | 数値 |
|---|---|
| 1ノートブックのソース上限 | 300件 |
| 週次消費ノートブック数 | 3冊（カテゴリ×1） |
| 週あたり新規収集件数 | 約50〜150件 |
| 年間消費ノートブック数 | 約156冊 |
| ノートブック上限（Plusプラン） | 500冊 |
| **持続可能期間** | **約3年** |

---

## 5. セットアップ手順

### 前提条件

- Python 3.11 以上（Windows）
- WSL2（Ubuntu 24.04）
- GitHubアカウント
- Googleアカウント（NotebookLM Plus）
- Anthropic APIキー
- Notionアカウント（任意）

### Step 1: ローカル環境のセットアップ

```powershell
# 【Windows】作業フォルダを作成
mkdir C:\Users\matuu\Desktop\GameDevelopment\Research-Collector
cd C:\Users\matuu\Desktop\GameDevelopment\Research-Collector

# 依存ライブラリのインストール
pip install feedparser requests python-dotenv
pip install "notebooklm-py[browser]"
playwright install chromium
```

### Step 2: NotebookLM への初回ログイン（WSL2で実施）

**重要: WSL2（Linux環境）でログインすること。**  
WindowsのCookieはGitHub Actions（Linux）で使用できないため。

```bash
# 【WSL2】
pip install "notebooklm-py[browser]"
playwright install chromium
notebooklm login
# ブラウザが開いたらGoogleにログインしてENTERを押す
```

### Step 3: NotebookLMノートブックの作成

```bash
# 【WSL2】週次ノートブックは自動作成されるため、固定ノートブックのみ手動作成
notebooklm create "Weekly-Digest"
# 表示されたIDをclient.pyのNOTEBOOK_IDS_FIXEDに記録する
```

### Step 4: GitHub Secretsの登録

```bash
# 【WSL2】storage_state.json を1行JSONに圧縮してコピー
cat ~/.notebooklm/storage_state.json | python3 -c \
  "import sys,json; print(json.dumps(json.load(sys.stdin)))"
```

GitHubリポジトリの `Settings → Secrets → Actions` に以下を登録：

| Secret名 | 内容 |
|---|---|
| `NOTEBOOKLM_AUTH_JSON` | 上記コマンドの出力（1行JSON） |
| `ANTHROPIC_API_KEY` | `sk-ant-...` で始まるAPIキー |
| `NOTION_TOKEN` | `ntn_...` で始まるトークン（任意） |

### Step 5: ローカル動作確認

```powershell
# 【Windows】
python main.py --mode check   # 認証確認
python main.py --mode daily   # 収集テスト
```

### Step 6: GitHubにpushして自動実行を有効化

```powershell
git add .
git commit -m "initial setup"
git push origin main
```

Actions タブ → `Daily Research Collect` → `Run workflow` で手動実行してテスト。

---

## 6. ファイル構成

```
research-collector/
├── .github/
│   └── workflows/
│       ├── daily_collect.yml      # 毎日 AM 6:00 JST 自動実行
│       └── weekly_digest.yml      # 毎週月曜 AM 7:00 JST 自動実行
├── collectors/
│   ├── zenn_qiita_collector.py    # Zenn/Qiita RSS収集
│   ├── unity_ue_collector.py      # Unity/UE 公式ブログ収集
│   ├── cedec_collector.py         # CEDiL新着 + CEDEC YouTube収集
│   └── paper_collector.py         # arXiv + Semantic Scholar論文収集
├── nbklm/
│   ├── __init__.py
│   ├── client.py                  # notebooklm-py ラッパー
│   ├── notebook_ids.py            # ノートブックID・振り分けルール定義
│   └── seen_urls.py               # 収集済みURL重複チェック管理
├── .env                           # ローカル用APIキー（gitignore済み）
├── .env.example                   # .envのテンプレート
├── .gitignore
├── main.py                        # メインエントリーポイント
├── requirements.txt
├── seen_urls.txt                  # 収集済みURLハッシュ（自動更新）
└── SETUP.md                       # このドキュメント
```

---

## 7. 運用マニュアル

### 通常運用（何もしなくてOK）

GitHub Actionsが以下のスケジュールで自動実行されます。

| タイミング | 内容 |
|---|---|
| 毎日 AM 6:00 JST | デイリー収集 → NotebookLMへ追加 |
| 毎週月曜 AM 7:00 JST | Weekly-DiggestのDeep Research → レポート生成 |

### NotebookLMの活用方法

```
① 週次ノートブック（例: Game-Dev-Tech-2026-W20）を開く
  → その週に収集された記事が自動追加されている

② チャットで質問する
  → 「今週のUnityの注目アップデートを教えて」
  → 「DirectX12に関する記事をまとめて」

③ Audio Overviewを生成する
  → 通勤中に今週の技術トレンドを耳で聞ける

④ Weekly-Digestノートブックで週次レポートを確認する
  → 毎週月曜に自動生成されたMarkdownレポートをoutput/フォルダで確認
```

### Cookieが切れた場合（定期的に必要）

GoogleのセッションCookieは数週間〜数ヶ月で失効します。  
GitHub Actionsが認証エラーで失敗したら以下を実施してください。

```bash
# 【WSL2】再ログイン
notebooklm login

# storage_state.json を1行JSONに圧縮
cat ~/.notebooklm/storage_state.json | python3 -c \
  "import sys,json; print(json.dumps(json.load(sys.stdin)))"

# 出力をコピーして GitHub Secrets の NOTEBOOKLM_AUTH_JSON を上書き更新
```

### seen_urls.txt のリセット方法

古いURLを再収集したい場合（ノートブックを作り直した時など）はリセットできます。

```powershell
# 【Windows】
del seen_urls.txt
git add seen_urls.txt
git commit -m "chore: reset seen_urls.txt"
git push
```

### 収集キーワードの追加・変更

**Zenn/Qiitaのタグを追加する場合**  
`collectors/zenn_qiita_collector.py` の `ZENN_FEEDS` または `QIITA_FEEDS` にURLを追加。

**論文の検索キーワードを変更する場合**  
`collectors/paper_collector.py` の `ARXIV_QUERIES` または `SEMANTIC_SCHOLAR_QUERIES` を編集。

---

## 8. トラブルシューティング

### Q: GitHub Actionsで認証エラーが出る

```
auth FAILED: Authentication expired or invalid
```

**対処:** [7. 運用マニュアル → Cookieが切れた場合] を参照して再ログイン。

---

### Q: `All articles already seen. Nothing to add.` と表示される

収集した記事が全て `seen_urls.txt` に記録済みのため正常動作です。  
新着記事がない日は何も追加されません。

---

### Q: NotebookLMへの追加でskipが大量に出る

```
NotebookLM: ok=10, skip=50, errors=50
```

フォーラム系URL（`forums.unrealengine.com` 等）はBot弾きで追加失敗することがあります。  
`unity_ue_collector.py` の `UNREAL_FEEDS` からフォーラムURLを削除すると改善します。

---

### Q: 週次ノートブックが作成されない

認証は成功しているのにノートブックが作成されない場合、  
`notebooklm-py` のバージョンアップで API が変わっている可能性があります。

```bash
pip install --upgrade notebooklm-py
```

---

### Q: GitHub Actionsのスケジュール実行が止まった

GitHubはリポジトリに60日間アクティビティがないとcronを停止します。  
`seen_urls.txt` の自動コミットがアクティビティとして認識されるため通常は止まりませんが、  
念のため月1回Actionsタブで実行履歴を確認してください。

---

### Q: seen_urls.txt がコミットされない

```
nothing to commit
```

新規記事がなかった場合は `seen_urls.txt` に変更がないため正常です。

---

## 付録: GitHub Secrets 一覧

| Secret名 | 説明 | 取得方法 |
|---|---|---|
| `NOTEBOOKLM_AUTH_JSON` | NotebookLM認証JSON | WSL2で `notebooklm login` 後に取得 |
| `ANTHROPIC_API_KEY` | Anthropic APIキー | https://console.anthropic.com |
| `NOTION_TOKEN` | Notion Integration Token | https://www.notion.so/profile/integrations |

## 付録: 実行コマンド早見表

```bash
# 認証確認
python main.py --mode check

# デイリー収集（手動実行）
python main.py --mode daily

# 週次Digest生成（手動実行）
python main.py --mode weekly

# notebooklm CLI
notebooklm list                    # ノートブック一覧
notebooklm login                   # 再ログイン
notebooklm create "ノートブック名"  # ノートブック作成
```
