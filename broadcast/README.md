# ResearchBroadcast — 取り込み・記事API・放送サイト(無料プランで動く構成)

`ResearchBroadcast_DESIGN.md`(第2版)の Cloudflare 側。Research-Collector の収集結果を受け取って D1 に保存し、記事・episode(番組表)を返し、サイトを配信する Worker。

**Cloudflare の Free プランだけで動かすため、設計から次を変えている**(差分は下の表)。使うのは Worker + D1 + 静的アセットだけで、R2・Containers・Workflows・Workers AI は使わない。

|                                                                    | 状態                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `POST /api/ingest`(記事・episode・失敗した収集元を受け取る)        | 実装・ローカルで検証済み                                  |
| `GET /api/articles` / `/api/episodes` / `/api/status`              | 実装・ローカルで検証済み                                  |
| ボード(読む・試す・保留)`/api/board`                               | 実装・ローカルで検証済み                                  |
| ログイン(パスワード → 署名つきCookie)`/api/login`                  | 実装・ローカルで検証済み                                  |
| サイト(今日の放送・カテゴリ・ボード・週次特集・状態)               | 実装。実ブラウザ(Chromium)で確認済み                      |
| D1 スキーマ(`migrations/0001_init.sql`・`0002_episodes_board.sql`) | 実装・ローカルD1で適用確認                                |
| **Cloudflare へのデプロイ**                                        | **済み**(2026-10-11。CLI だけで実施。下記「デプロイ」)    |
| 音声ファイル・動画・Slack通知・Access                              | 未実装(無料プランの範囲外、または後続。下記「設計との差分」) |

---

## 設計との差分(無料プラン)

| 設計(§) | この実装 | 理由・影響 |
| --- | --- | --- |
| episode を Workflows で生成(§4.2) | **GitHub Actions 上の Python が生成**し、`/api/ingest` で送る(`nbklm/episodes.py`) | Free の Worker は CPU 時間 10ms。Workflows は使わない。見出しは規則ベースで、AI も使わない |
| episode の JSON を R2 に保存(§4.3) | **D1 の `episodes` テーブル**に直接保存(1件 最大200KB、実測は約10KB以下) | R2 を使わない |
| 音声は VOICEVOX(Containers)(§6) | **ブラウザの読み上げ(`speechSynthesis`)** | 無料。声は端末による。音声ファイルは作らない |
| 月次・先月の特集 | **「今日 / 今週 / 30日」** と週次特集 | 保持が90日で、月次を作るには足りない場合がある |
| Cloudflare Access(§8) | **パスワードでログイン**(署名つき Cookie)。Access は任意で後から重ねられる | Access の無料枠の条件が未確認 |
| ボードのオフライン書き込み | なし(オンラインのみ) | Service Worker を使わない |
| ティッカー・スクロールで展開する演出 | なし | 動きは「カウントアップ」「フェードイン」の2種類だけ |

## サイト

`public/` を Workers の静的アセットとして配信する(配信は無料・無制限)。`/api/*` だけが Worker で動く。HTML 文字列は作らず(`textContent` のみ)、リンク先は http(s) だけを通す。CSP は `public/_headers`。

| パス | 内容 |
| --- | --- |
| `/` | 今日の放送。注目・カテゴリ別の3レーン・日付の切り替え・読み上げ。複数カテゴリの記事は「ほかのカテゴリにも」バッジ |
| `/c/<category>` | カテゴリ。期間(今日 / 今週 / 30日)・収集元のチップ・要確認のみ |
| `/board` | 読む / 試す / 保留 |
| `/weekly[/<YYYY-Www>]` | 週次特集。日別の件数・カテゴリ別の件数(SVG)・章ごとの記事 |
| `/status` | 取り込みの状態・件数・失敗した収集元。取り込みが止まっているとバッジを出す |
| `/login` | パスワード入力 |

記事を開くドロワーは、Esc で閉じ、フォーカスを内側に閉じ込め、閉じると元の位置へ戻す。`prefers-reduced-motion` では動きを止める。

## 契約(schema 1)

送信側は `scripts/post_ingest.py`。同じ記事・episode を再送しても、`url_hash` / episode の `id` で upsert されるので重複しない(冪等)。

```http
POST /api/ingest
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

```json
{
  "schema": 1,
  "sent_at": "2026-10-11T00:00:00Z",
  "run": { "run_at": "2026-10-10T21:01:56Z", "collected": 96, "new": 3, "failed_sources": 0, "unclassified": 1 },
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
  ],
  "episodes": [
    {
      "id": "daily:2026-10-11:game_dev_tech",
      "kind": "daily",
      "date": "2026-10-11",
      "category": "game_dev_tech",
      "headline": "Game-Dev-Tech: 新着24件 — …",
      "data": { "count": 24, "sources": [{ "platform": "zenn", "count": 6 }], "items": [] }
    }
  ],
  "failures": [{ "source": "https://…", "error": "HTTP 503" }]
}
```

| 項目 | 規則 |
| --- | --- |
| `categories` | `game_dev_tech` / `graphics_research` / `software_engineering` の1つ以上。**これ以外(ローカル限定の分野)は受け付けない** |
| `status` | `added`(NotebookLMへ追加済み) / `failed` / `merged`(類似記事に統合) |
| `summary` | 任意。**`source_type` が `x_post` のときは、送られてきても保存しない**(設計 §5: X の本文を再掲載しない) |
| `episodes[].id` | `daily:YYYY-MM-DD:<all or category>` / `weekly:YYYY-Www:all`。`kind` / `date` / `category` は id と一致していること。1回20件・1件200KBまで |
| `failures` | 直近の実行で取得に失敗した収集元(20件まで)。省くと前回の値を残す。空配列で「失敗なし」に更新 |
| 1回の記事数 / 本文サイズ | 200件 / 1 MB まで。送信側は100件ずつに分け、episode と failures は最初のバッチにだけ載せる |
| 古い形式の行 | `summary` 等が無くても受け付ける(後方互換) |

応答: `200 {"ok":true,"accepted":n,"rejected":m,"episodes":k,"errors":[…]}`。**送られた記事・episode が1件も受け付けられなければ `422`**(契約違反に気づけるように)。失敗の状態だけの送信は `200`。

## API

| メソッド・パス | 認証 | 内容 |
| --- | --- | --- |
| `POST /api/ingest` | Bearer のみ | 取り込み。保持期間(既定90日)を過ぎた記事・日次 episode も、ここで削除する |
| `GET /api/articles` | Bearer か Cookie | `category` / `status` / `since=YYYY-MM-DD` / `review=1` / `limit`(1〜200) / `offset`。複数カテゴリの記事は、どのカテゴリで絞っても出る |
| `GET /api/episodes` | 同上 | `kind=daily\|weekly` / `date=latest\|YYYY-MM-DD\|YYYY-Www` / `category=all\|<カテゴリ>` |
| `GET /api/episodes/dates` | 同上 | episode のある日付(最大60) |
| `GET /api/board` / `PUT・DELETE /api/board/{url_hash}` | 同上(書き込みは Cookie のとき Origin も検査) | `{"state":"reading\|try\|hold\|unread","note":"…200字まで"}`。`unread` は行を消す |
| `GET /api/status` | 同上 | 件数(URL単位)・カテゴリ別・`last_ingest`・`last_success_at`・`failures`・最新の episode |
| `POST /api/login` / `POST /api/logout` / `GET /api/session` | なし(login は Origin 検査) | `VIEW_PASSWORD` を送ると `rb_session` Cookie(HttpOnly・SameSite=Strict・Secure・30日)を発行する |
| `GET /api/health` | なし | 生存確認のみ。データは返さない |

認証は2通り: **機械**(GitHub Actions)は `Authorization: Bearer <INGEST_TOKEN>`、**人**(ブラウザ)は `VIEW_PASSWORD` でログインして得る Cookie。取り込みは Bearer のみ。`INGEST_TOKEN` も `VIEW_PASSWORD` も未設定なら、認証が要る経路は **全て拒否(503)** する。比較は SHA-256 にしてから `crypto.subtle.timingSafeEqual`(定数時間)。誤ったパスワードは 800ms 待ってから返す(総当たりを遅くするだけなので、**パスワードは長く**すること)。

---

## ローカルで試す(Cloudflare のアカウント不要)

```bash
cd broadcast
npm install
cp .dev.vars.example .dev.vars          # INGEST_TOKEN と VIEW_PASSWORD を好きな文字列に(.dev.vars はコミットされない)
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local                # http://127.0.0.1:8787  (ブラウザで開き、VIEW_PASSWORD でログイン)
```

別のターミナルから(リポジトリのルートで):

```bash
export BROADCAST_INGEST_URL=http://127.0.0.1:8787/api/ingest   # ループバックだけ http を許可している
export BROADCAST_INGEST_TOKEN=<.dev.vars と同じ値>
python scripts/post_ingest.py --since-hours 100000
```

テスト:

- `npm test` — 検証・認証ロジックの単体テスト(ランタイム不要。21項目)
- `python broadcast/test/integration_local.py` — `wrangler dev --local` を起動した状態で、実クライアントと実際の記事ログを使った結合テスト(62項目。認証・冪等・episode・ボード・ログイン・CSRF・範囲外カテゴリの拒否など)。ローカルのD1にだけ書き込む
- `python broadcast/test/browser_local.py` — 同じ状態で、Playwright(Chromium)によるサイトの確認(約45項目。ログイン・ドロワー・ボードの保持・週次の図・スマホ幅の横はみ出し・動きの軽減・ログアウト・CSP違反なし)。`pip install playwright && playwright install chromium` が要る

---

## デプロイ

**2026-10-11 に実施済み**(Worker `research-broadcast` + D1 `research-broadcast`(APAC)。`wrangler.jsonc` の `database_id` は反映済み)。
以下は、最初に行った手順と、作り直すときの手順。CLI だけで行える(ダッシュボード操作は不要)。`wrangler login` は一度ブラウザで許可する。
コードを更新したときは `npx wrangler deploy` だけでよい(migration を足したときは先に `npx wrangler d1 migrations apply DB --remote`)。

```bash
cd broadcast
npx wrangler login
npx wrangler d1 create research-broadcast          # 出力の database_id を wrangler.jsonc の REPLACE_WITH_D1_DATABASE_ID に書く
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put INGEST_TOKEN               # 対話で入力(機械用。長いランダム文字列)
npx wrangler secret put VIEW_PASSWORD              # 対話で入力(人用。長いパスワード)
npx wrangler deploy                                # https://research-broadcast.<アカウント>.workers.dev
```

GitHub 側(登録するまで、Actions の送信ステップは何もしない):

```bash
gh secret set BROADCAST_INGEST_URL     # https://research-broadcast.<アカウント>.workers.dev/api/ingest
gh secret set BROADCAST_INGEST_TOKEN   # INGEST_TOKEN と同じ値
```

取り消し: `npx wrangler delete`(Worker)、`npx wrangler d1 delete research-broadcast`(DB)、`gh secret delete …`。

### 公開範囲(設計 §8)

- サイトの HTML/JS/CSS には**データが入っていない**。データは `/api/*` から、Bearer かログイン済みの Cookie でしか取れない。
- `READ_REQUIRES_TOKEN` を `"false"` にするのは、**Cloudflare Access で、この Worker の全ホスト名(`workers.dev` を含む)を保護した後だけ**。保護していない状態で `"false"` にすると、記事・ボードが誰にでも読み書きできる。
- Access のサービス認証(`CF-Access-Client-Id` / `CF-Access-Client-Secret`)を使う場合は、Actions の Secret `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` を設定すれば、送信側が付けて送る。

## 未確認

- **本番での確認(2026-10-11)**: 認証(未ログインは 401)・実クライアントによる取り込み(記事40件 + episode 8件が1バッチで成功。約2.5秒)・再送で増えないこと・パスワードのログインと Cookie の属性(Secure・HttpOnly・SameSite=Strict)・Origin の異なる書き込みの拒否・実ブラウザでのサイト操作を確認した。
- **Free プランでの CPU 時間**: Free は Worker の CPU 時間が 10ms。上記の取り込みはエラーなく成功したが、CPU 時間そのものは測っておらず、アカウントのプランも確認していない。`wrangler tail` で例外(1102)が出ていないかを、数日の運用で見ること。出るようなら `post_ingest.py` の `BATCH_SIZE` を下げるか、Paid(月5ドル)にする。
- **D1 の1回のバッチの上限**: 50文ずつに分けて実行している。本番の取り込みは成功した(今回は40件)。件数が増えた日の挙動は未確認。
- **Actions からの送信**: GitHub Secrets は登録済みだが、定期実行(日次ワークフロー)からの初回の送信は、次回の実行で確認する。
- **読み上げの声**: 端末・ブラウザ次第。日本語の音声が入っていない端末では読み上げられない(ボタンは出るが無音になる場合がある)。
- **スマホ実機**: 幅 390px の描画でしか確認していない(実機のタッチ操作は未確認)。
