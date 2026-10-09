# research-collector セットアップ手順

## 1. ローカルで一度だけ実施する作業

### NotebookLM 認証（Windows）

```powershell
pip install "notebooklm-py[browser]==0.7.3"
playwright install chromium
notebooklm login
# ブラウザが開いたら Google にログインして ENTER を押す
# → storage_state.json が生成される（保存先はバージョンにより異なる。下記参照）
```

> **保存先について**: notebooklm-py 0.7.3以降はプロファイル形式
> (`C:\Users\<name>\.notebooklm\profiles\default\storage_state.json`) に保存される。
> 旧バージョンからの移行直後は従来のパス
> (`C:\Users\<name>\.notebooklm\storage_state.json`) のままのこともある。
> `refresh_auth.ps1` は両方を自動判定するので、通常は気にする必要はない。

### storage_state.json を Secret 用テキストに変換

`refresh_auth.ps1` と同じ変換（JSONをそのまま圧縮文字列化。Base64エンコードは不要）:

```powershell
(Get-Content "C:\Users\matuu\.notebooklm\profiles\default\storage_state.json" -Raw |
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
| `GH_PAT_SECRETS_WRITE` | Secrets書き込み権限のみを持つFine-grained PAT（`auth_keepalive.yml`用。下記5参照） |

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

### 自動キープアライブ（auth_keepalive.yml）

NotebookLMの認証には2種類の失効パターンがある:

- **SIDファミリー**: 数百日単位で有効。自然には滅多に切れない
- **`__Secure-1PSIDTS`**: Google側の設計上、**15〜20分ごとにローテーションしないと失効する**

後者に対応するため `.github/workflows/auth_keepalive.yml` が15分おきに
`notebooklm auth refresh` を実行し、ローテーション結果を `NOTEBOOKLM_AUTH_JSON`
Secretへ自動的に書き戻す。これには **Secrets書き込み権限を持つPAT**
(`GH_PAT_SECRETS_WRITE`) が必要:

1. https://github.com/settings/personal-access-tokens/new を開く
2. Repository access → 対象リポジトリのみ選択
3. Permissions → Repository permissions → **Secrets: Read and write**
4. 発行したトークンを登録:
   ```powershell
   gh secret set GH_PAT_SECRETS_WRITE --repo あなたのユーザー名/リポジトリ名
   ```

### 手動更新が必要な場合

上記のキープアライブでも救えない失効（自然失効・アカウント側の問題など）が
起きた場合や、`refresh-soon` / `auth-expired` ラベルのIssueが作成された場合は
`refresh_auth.ps1` を再実行する（ログイン〜Secret更新〜Issueクローズまで自動）。

```powershell
.\refresh_auth.ps1
```

## 6. NotebookLM との連携フロー

```
毎日 6:00 / 18:00 (JST)
  → RSS・API 収集（Zenn/Qiita/Unity Blog/UE Blog/CEDEC/SideFX/Cloudflare/Hugging Face、
    論文は月・木、X投稿は x_urls.txt のURLのみ）
  → 重複除去（URL + タイトルの類似）→ 分類の補助（どれでもない = 人の確認）
  → NotebookLM の各ノートブックに自動追加
  → articles_log.json / health.json / results.html を更新してコミット

水曜・日曜 7:00 (JST)
  → 当週のノートブックからカテゴリ別の日本語レポートを生成
  → まとめレポート（Markdown）を output/ に保存
  → NotebookLM 上でポッドキャスト・Q&A が生成可能な状態になる
```

---

## 7. 2026-10 に追加した機能の設定(任意)

追加のSecretは**不要**。以下は必要なときだけ設定する。詳細は DOCUMENT.md 12章。

| やりたいこと | 設定 |
|---|---|
| Xの投稿を取り込む | `x_urls.txt` に `https://x.com/<ユーザー名>/status/<ID>` を1行ずつ書いてpush。書いたURLだけが対象。取得できなかった投稿は次回の実行で再試行される |
| 似たタイトルの統合(重複判定)を止める | 環境変数 `SEMANTIC_DEDUP=0`。閾値の変更は `SEMANTIC_DEDUP_THRESHOLD`(既定 0.95。低くすると別の話題を誤って統合しやすくなる) |
| 新着監視の対象を増やす | `collectors/watch_collector.py` の `WATCHES` に追加。通知のみで、導入はされない |
| 収集結果を見る | `results.html` をブラウザで開く。日次・週次の実行のたびに自動更新される(GitHub Pages等で公開するかは自分で決める) |
| 分類のキーワードを調整する | `nbklm/classifier.py`。精度は `agreement_report()` で自分のデータから測れる |

`articles_log.json` / `watch_state.json` / `results.html` はGitHub Actionsが自動でコミットする(初回の実行後に現れる)。
