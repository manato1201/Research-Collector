# ResearchBroadcast — Phase 1(取り込みと記事API)

`ResearchBroadcast_DESIGN.md`(第2版)の **Phase 1** のうち、Cloudflare 側の部分。Research-Collector の収集結果を受け取って D1 に保存し、記事を返す小さな Worker。

|                                                                          | 状態                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `POST /api/ingest`(Actions から記事を受け取る)                           | 実装・ローカルで検証済み                             |
| `GET /api/articles`(カテゴリ・期間・要確認で絞り込み)                    | 実装・ローカルで検証済み                             |
| `GET /api/status`(件数はURL単位、カテゴリ別、直近の取り込み)             | 実装・ローカルで検証済み                             |
| D1 スキーマ(`migrations/0001_init.sql`)                                  | 実装・ローカルD1で適用確認                           |
| **Cloudflare へのデプロイ**                                              | **未実施**(アカウントの作業が必要。下記「デプロイ」) |
| Phase 0 のスパイク(Containers で VOICEVOX、Workflows、Workers AI の要約) | **未実施**(有料プランでの測定が必要)                 |
| Phase 2 以降(episode の生成・サイト・音声・動画・Access・Slack通知)      | 未実装                                               |

> 設計の Phase 0 は「Containers で VOICEVOX が動くか」を先に測る段階で、結果次第で音声の方式(§6.3 の保険)が変わる。Phase 1 はそれに依存しないので先に作ったが、**Phase 2 以降は Phase 0 の測定値を見てから**進める。

---

## 契約(schema 1)

送信側は `scripts/post_ingest.py`。同じ記事を再送しても、`url_hash` で upsert されるので重複しない(冪等)。

```http
POST /api/ingest
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

```json
{
  "schema": 1,
  "sent_at": "2026-10-11T00:00:00Z",
  "run": {
    "run_at": "2026-10-10T21:01:56Z",
    "collected": 96,
    "new": 3,
    "failed_sources": 0,
    "unclassified": 1
  },
  "articles": [
    {
      "url_hash": "5167f4fb33ed3fe2",
      "url": "https://zenn.dev/…",
      "title": "…",
      "source_type": "unity",
      "platform": "zenn",
      "categories": ["game_dev_tech", "graphics_research"],
      "label": "graphics_research",
      "keywords": ["rendergraph"],
      "review": false,
      "status": "added",
      "published": "2026-10-10",
      "collected_at": "2026-10-10T21:00:00Z",
      "summary": "フィードの要約を140文字以内に切ったもの(無い記事は項目ごと省く)",
      "summary_src": "feed",
      "merged_into": "https://… (status が merged のときだけ)"
    }
  ]
}
```

| 項目                     | 規則                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `categories`             | `game_dev_tech` / `graphics_research` / `software_engineering` の1つ以上。**これ以外(ローカル限定の分野)は受け付けない** |
| `status`                 | `added`(NotebookLMへ追加済み) / `failed` / `merged`(類似記事に統合)                                                      |
| `summary`                | 任意。**`source_type` が `x_post` のときは、送られてきても保存しない**(設計 §5: X の本文を再掲載しない)                  |
| 1回の記事数 / 本文サイズ | 200件 / 1 MB まで。送信側は100件ずつに分けて送る                                                                         |
| 古い形式の行             | `summary` 等が無くても受け付ける(後方互換)                                                                               |

応答: `200 {"ok":true,"accepted":n,"rejected":m,"errors":[{"index":i,"error":"…"}]}`。**1件も受け付けられなければ `422`**(契約違反に気づけるように)。

## API

| メソッド・パス      | 認証             | 内容                                                                                                                                   |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/ingest`  | 常にBearer必須   | 取り込み。保持期間(既定90日)を過ぎた記事も、ここで削除する                                                                             |
| `GET /api/articles` | 既定でBearer必須 | `category` / `status` / `since=YYYY-MM-DD` / `review=1` / `limit`(1〜200) / `offset`。複数カテゴリの記事は、どのカテゴリで絞っても出る |
| `GET /api/status`   | 既定でBearer必須 | `articles.total`(URL単位)・`by_category`・`review`、`last_ingest`(直近の取り込み)、`last_success_at`(最後に1件以上受け付けた時刻)      |
| `GET /api/health`   | なし             | 生存確認のみ。データは返さない                                                                                                         |

`INGEST_TOKEN` が未設定のとき、認証が要る経路は **全て拒否(503)** する(未設定のまま公開してしまう事故を防ぐ)。トークンの比較は、SHA-256 にしてから `crypto.subtle.timingSafeEqual`(定数時間)。

---

## ローカルで試す(Cloudflare のアカウント不要)

```bash
cd broadcast
npm install
cp .dev.vars.example .dev.vars          # INGEST_TOKEN を好きな文字列に(.dev.vars はコミットされない)
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local                # http://127.0.0.1:8787
```

別のターミナルから(リポジトリのルートで):

```bash
export BROADCAST_INGEST_URL=http://127.0.0.1:8787/api/ingest   # ループバックだけ http を許可している
export BROADCAST_INGEST_TOKEN=<.dev.vars と同じ値>
python scripts/post_ingest.py --since-hours 100000
curl -H "Authorization: Bearer $BROADCAST_INGEST_TOKEN" "http://127.0.0.1:8787/api/status"
```

テスト:
- `npm test` — 検証ロジックの単体テスト(ランタイム不要)
- `python broadcast/test/integration_local.py` — `wrangler dev --local` を起動した状態で、実クライアントと実際の記事ログを使った結合テスト(26項目。認証・冪等・カテゴリ絞り込み・範囲外カテゴリの拒否など)。ローカルのD1にだけ書き込む

---

## デプロイ(アカウントの作業。まだ行っていない)

1. `npx wrangler login`
2. `npx wrangler d1 create research-broadcast` → 出力の `database_id` を `wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` に書く
3. `npx wrangler d1 migrations apply DB --remote`
4. `npx wrangler secret put INGEST_TOKEN`(対話で入力。長いランダム文字列)
5. `npx wrangler deploy`
6. GitHub のリポジトリのSecretsに `BROADCAST_INGEST_URL`(`https://<worker>.workers.dev/api/ingest`)と `BROADCAST_INGEST_TOKEN`(4と同じ値)を登録する。**登録するまでは、Actions の送信ステップは何もしない**

### 公開範囲(設計 §8)

- 既定では、読み出し(`GET /api/*`)にもトークンが要る。**Cloudflare Access で、この Worker の全ホスト名(`workers.dev` を含む)を保護した後でだけ**、`wrangler.jsonc` の `READ_REQUIRES_TOKEN` を `"false"` にする。Access で保護していない状態で `"false"` にすると、記事一覧が誰にでも読める。
- `/api/ingest` を Access とどう両立させるかは、設計上「実装時に確定」。Bearer トークンを基本とし、Access のサービス認証(`CF-Access-Client-Id` / `CF-Access-Client-Secret`)を使う場合は、Actions の Secret `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` を設定すれば、送信側が付けて送る。

## 未確認(設計 §11 の項目のうち、この Phase に関係するもの)

- **Cloudflare 上での実動作**: ここまでの検証は `wrangler dev --local`(workerd + ローカルのD1)まで。
- **Free プランでの CPU 時間**: 設計 §3.1 のとおり Free は Worker の CPU 時間が 10ms。100件の upsert が収まるかは未測定。収まらなければ Paid(月5ドル。設計の前提)にする。
- **D1 の1回のバッチの上限**: 50文ずつに分けて実行している。実環境での上限は未確認。
