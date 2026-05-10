"""
NotebookLM ノートブックID設定
=================================
【セットアップ時に編集が必要な箇所】

1. NOTEBOOK_IDS_FIXED の weekly_digest に
   `notebooklm create "Weekly-Digest"` で作成したIDを入力してください。

2. SOURCE_TYPE_TO_CATEGORIES は収集ソースとノートブックの
   振り分けルールです。必要に応じて変更してください。

3. CATEGORY_TO_NOTEBOOK_NAME はノートブック名のテンプレートです。
   {YYYY} = 年, {WNN} = 週番号（例: W20）に自動で置換されます。
"""

import os

# ============================================================
# ▼ ここを編集してください（セットアップ必須）
# ============================================================

NOTEBOOK_IDS_FIXED = {
    # notebooklm create "Weekly-Digest" で作成したIDを入力
    "weekly_digest": os.environ.get(
        "NOTEBOOKLM_WEEKLY_DIGEST_ID",
        "ここにWeekly-DigestのIDを貼り付ける",  # ← 変更必須
    ),
}

# ============================================================
# ▼ 必要に応じて変更（デフォルトのまま使えます）
# ============================================================

# source_type → 追加先カテゴリのルーティング
# 複数指定すると同じ記事が複数のノートブックに追加されます
SOURCE_TYPE_TO_CATEGORIES = {
    # Zenn/Qiita → ゲーム開発ノートブックのみ
    "zenn":    ["game_dev_tech"],
    "qiita":   ["game_dev_tech"],

    # Unity/UE → ゲーム開発 + グラフィクスの両方
    "unity":   ["game_dev_tech", "graphics_research"],
    "unreal":  ["game_dev_tech", "graphics_research"],

    # CEDEC/GDC → グラフィクス + ソフトウェア工学の両方
    "cedec":   ["graphics_research", "software_engineering"],
    "gdc":     ["graphics_research", "software_engineering"],

    # 論文 → ソフトウェア工学のみ
    "paper":   ["software_engineering"],
    "arxiv":   ["software_engineering"],
}

# 週次ノートブック名のテンプレート
# {YYYY} → 年（例: 2026）, {WNN} → 週番号（例: W20）に自動置換
CATEGORY_TO_NOTEBOOK_NAME = {
    "game_dev_tech":        "Game-Dev-Tech-{YYYY}-{WNN}",
    "graphics_research":    "Graphics-Research-{YYYY}-{WNN}",
    "software_engineering": "Software-Engineering-{YYYY}-{WNN}",
}
