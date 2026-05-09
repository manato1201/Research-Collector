"""
NotebookLM ノートブックID定数
作成日: 2026-04-23
"""

NOTEBOOK_IDS = {
    "game_dev_tech":      "58d77b83-1320-4232-8029-778e4bf9991a",  # Game-Dev-Tech
    "graphics_research":  "b54469a1-bf3c-4da5-9f6b-0e86b6d16e26",  # Graphics-Research
    "software_engineering": "35612c0b-0e70-4744-a171-9106dc7497bf",  # Software-Engineering
    "weekly_digest":      "0942eb24-05f7-45e5-a3d9-1f67e1c5ca0a",  # Weekly-Digest
}

# source_type → notebook のルーティング
SOURCE_TYPE_TO_NOTEBOOK = {
    "unity":   "game_dev_tech",
    "unreal":  "game_dev_tech",
    "zenn":    "game_dev_tech",
    "qiita":   "game_dev_tech",
    "cedec":   "graphics_research",
    "gdc":     "graphics_research",
    "paper":   "software_engineering",
    "arxiv":   "software_engineering",
}
