# research-collector セットアップ手順

## 1. ローカルで一度だけ実施する作業

### NotebookLM 認証（Windows）

```powershell
pip install "notebooklm-py[browser]"
playwright install chromium
notebooklm login
# ブラウザが開いたら Google にログインして ENTER を押す
# → C:\Users\<name>\.notebooklm\storage_state.json が生成される
```

### storage_state.json を Base64 エンコード

**PowerShell:**
```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("C:\Users\matuu\.notebooklm\storage_state.json")
) | Set-Clipboard
```

**WSL2:**
```bash
base64 -w 0 /mnt/c/Users/matuu/.notebooklm/storage_state.json | xclip -selection clipboard
```

## 2. GitHub Secrets の登録

リポジトリの `Settings → Secrets and variables → Actions → New repository secret`

| Secret 名 | 内容 |
|---|---|
| `NOTEBOOKLM_STORAGE_STATE` | storage_state.json の Base64 文字列 |
| `NOTION_TOKEN` | Notion Integration Token |
| `ANTHROPIC_API_KEY` | Anthropic API Key |

## 3. ノートブック ID（作成済み）

| ノートブック | ID |
|---|---|
| Game-Dev-Tech | `58d77b83-1320-4232-8029-778e4bf9991a` |
| Graphics-Research | `b54469a1-bf3c-4da5-9f6b-0e86b6d16e26` |
| Software-Engineering | `35612c0b-0e70-4744-a171-9106dc7497bf` |
| Weekly-Digest | `0942eb24-05f7-45e5-a3d9-1f67e1c5ca0a` |

## 4. ローカル動作確認

```bash
# 認証チェック
python main.py --mode check

# デイリー収集（手動テスト）
python main.py --mode daily

# 週次 Digest 生成
python main.py --mode weekly
```

## 5. Cookieの期限切れ対処

Google セッションは数週間〜数ヶ月で失効します。
GitHub Actions が失敗したら以下を再実行して Secret を更新してください。

```powershell
notebooklm login
# → storage_state.json を再生成
# → Base64 エンコードして GitHub Secret を上書き
```

## 6. NotebookLM との連携フロー

```
毎日 AM 6:00
  → RSS 収集（Zenn/Qiita/Unity Blog/UE Blog）
  → NotebookLM の各ノートブックにURLを自動追加

毎週月曜 AM 7:00
  → Weekly-Digest ノートブックで Deep Research 実行
  → まとめレポート（Markdown）を output/ に保存
  → NotebookLM 上でポッドキャスト・Q&A が生成可能な状態になる
```
