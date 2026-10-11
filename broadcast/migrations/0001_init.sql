-- ResearchBroadcast Phase 1: 記事と、取り込みの状態。ResearchBroadcast_DESIGN.md §4.3
-- episodes / jobs / board は Phase 2 以降(episode の生成・ボード)で追加する。

CREATE TABLE IF NOT EXISTS articles (
  url_hash     TEXT PRIMARY KEY,           -- 主キー。同じ記事の再送は upsert される(冪等)
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  platform     TEXT NOT NULL,
  categories   TEXT NOT NULL,              -- JSON配列(例: ["game_dev_tech","graphics_research"])
  label        TEXT,                       -- 分類の補助の結果。"none" = どれでもない
  keywords     TEXT NOT NULL DEFAULT '[]', -- JSON配列
  review       INTEGER NOT NULL DEFAULT 0, -- 1 = 人の確認が必要(未分類)
  status       TEXT NOT NULL,              -- added / failed / merged
  published    TEXT,                       -- YYYY-MM-DD
  collected_at TEXT NOT NULL,              -- YYYY-MM-DDTHH:MM:SSZ
  summary      TEXT,                       -- フィードの要約を短く切ったもの(設計 §5 段階0)
  summary_src  TEXT,                       -- feed / ai
  merged_into  TEXT,                       -- 統合先のURL(status = merged のとき)
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_collected ON articles (collected_at);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
