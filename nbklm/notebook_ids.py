"""
NotebookLM ノートブックID定数
更新日: 2026-05-09 週次ノートブック対応
"""

# 固定ノートブック（Weekly-Digestのみ固定）
NOTEBOOK_IDS_FIXED = {
    "weekly_digest": "0942eb24-05f7-45e5-a3d9-1f67e1c5ca0a",
}

# source_type → カテゴリリスト（複数ノートブックに同時追加）
SOURCE_TYPE_TO_CATEGORIES = {
    "zenn":    ["game_dev_tech"],
    "qiita":   ["game_dev_tech"],
    "unity":   ["game_dev_tech", "graphics_research"],
    "unreal":  ["game_dev_tech", "graphics_research"],
    "cedec":   ["graphics_research", "software_engineering"],
    "gdc":     ["graphics_research", "software_engineering"],
    "paper":   ["software_engineering"],
    "arxiv":   ["software_engineering"],
}

# カテゴリ → ノートブック名テンプレート
# {YYYY} = 年, {WNN} = 週番号（例: W20）
CATEGORY_TO_NOTEBOOK_NAME = {
    "game_dev_tech":        "Game-Dev-Tech-{YYYY}-{WNN}",
    "graphics_research":    "Graphics-Research-{YYYY}-{WNN}",
    "software_engineering": "Software-Engineering-{YYYY}-{WNN}",
}
