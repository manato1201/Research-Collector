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

### storage_state.json を Secret 用テキストに変換

`refresh_auth.ps1` と同じ変換（JSONをそのまま圧縮文字列化。Base64エンコードは不要）:

```powershell
(Get-Content "C:\Users\matuu\.notebooklm\storage_state.json" -Raw |
  ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10) | Set-Clipboard
```

## 2. GitHub Secrets の登録

リポジトリの `Settings → Secrets and variables → Actions → New repository secret`

| Secret 名 | 内容 |
|---|---|
| `NOTEBOOKLM_AUTH_JSON` | 上記で生成した storage_state.json の圧縮JSON文字列（Base64ではなく生JSON） |
| `NOTEBOOKLM_WEEKLY_DIGEST_ID` | `notebooklm create "Weekly-Digest"` で作成したノートブックID |
| `NOTION_TOKEN` | Notion Integration Token（任意） |
| `ANTHROPIC_API_KEY` | Anthropic API Key |

## 3. ノートブックの扱い

カテゴリ別ノートブック（Game-Dev-Tech / Graphics-Research / Software-Engineering）は
**事前作成不要**。`nbklm/client.py` が実行時に `Game-Dev-Tech-{YYYY}-{WNN}` のような
週次名で自動的に検索し、なければ自動作成する（`nbklm/notebook_ids.py` の
`CATEGORY_TO_NOTEBOOK_NAME` テンプレートで名前を管理）。

事前に用意が必要なのは `Weekly-Digest` ノートブックのみ。作成したら発行された
IDを `NOTEBOOKLM_WEEKLY_DIGEST_ID` Secretに登録する。

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
GitHub Actions が失敗した、または `refresh-soon` ラベルのIssueが作成されたら
`refresh_auth.ps1` を再実行してください（ログイン〜Secret更新〜Issueクローズまで自動）。

```powershell
.\refresh_auth.ps1
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
