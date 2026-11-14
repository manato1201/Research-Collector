# 5. テストの書き方と実行

## 実行

```bash
python -m unittest discover tests            # 全部(ネットワーク不要・標準ライブラリ)
python -m pytest -q tests/test_docs.py       # 文書の検査(pytest が要る)
python -m unittest tests.test_2026_10        # 1 ファイルだけ
cd broadcast && node --test test/            # ResearchBroadcast(Node)の検証
```

## テストの置き場所と、何を確かめるか

| ファイル | 確かめるもの |
|---|---|
| `test_2026_10.py` | 意味の重複(連載・OS 別の誤統合)・分類・変更履歴・X・外部入力のエスケープ |
| `test_episodes.py`・`test_week_keywords.py` | 日次・週次のエピソード・週のキーワード |
| `test_report.py` | レポート・ダイジェストの組み立て |
| `test_broadcast.py`・`test_notify.py`・`test_enrich.py` | 送信・通知・要約(偽の送信先) |
| `test_game_media.py`・`test_s2_retry.py` | 収集元・失敗の再試行 |
| `test_backup.py` | D1 のバックアップ・保持 |
| `test_docs.py` | 文書の検査 |

## よく使う型

1. **ネットワークを使わない**: 取得の部分を**偽の応答**に差し替える(`test_game_media.py`・`test_s2_retry.py` の形に合わせる)。新しい収集元も、取得と解析を分けて書くと、解析だけをテストできる。
2. **固定のタイトル・固定の時刻**: `now` を引数にする(`episodes.build_for_run(entries, now)`)。
3. **実データで見つけた落とし穴を、テストに固定する**: 誤統合(連載・OS 別)・切れたタイトル・外部入力のエスケープ。
4. **ファイルは一時フォルダ**: `seen_urls.txt`・`articles_log.json` の場所を、一時フォルダへ向ける。
5. **「何もしない」を確かめる**: Secrets が無いとき、送信・通知が**何もしない**こと。

## 新しい機能のテストを書く手順

1. **失敗するテストを先に**。2. 実装して通す。3. **壊れた入力**(空の題名・`None`・巨大な本文)。4. **実データで見つけた誤り**を、1 件ずつ固定。

## 文書の検査

```bash
python tools/check_docs.py             # 検査(標準ライブラリだけ)
python tools/check_docs.py --update    # 引用の更新・実行例の出力の作り直し
python tools/check_mermaid.py          # Mermaid が描画できるか(mmdc が要る)
python tools/make_diagrams.py          # 構成図(SVG)を作り直す
```

## 確かめていないこと(正直に)

- **NotebookLM への実際の追加**(`nbklm/client.py`)は、自動テストに含まれない(非公式のクライアント・認証が要る)。
- **GitHub Actions 上での実行**・タスクスケジューラでの認証の更新は、ここでは確かめていない。
- 日本語の**分類の精度**・**意味の重複のしきい値**の最適さは、自データでの評価が要る。
