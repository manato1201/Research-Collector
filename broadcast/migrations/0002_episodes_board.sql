-- ResearchBroadcast Phase 2: episode(番組表)とボード。ResearchBroadcast_DESIGN.md §4.3
-- R2 を使わない(無料プランで動かす)ため、episode の JSON は D1 に直接保存する(1件 最大約200KB、実測は約10KB以下)。

CREATE TABLE IF NOT EXISTS episodes (
  id         TEXT PRIMARY KEY,   -- 種別:日付:カテゴリ(例: daily:2026-10-11:game_dev_tech)。再送は上書き(冪等)
  kind       TEXT NOT NULL,      -- daily / weekly
  date       TEXT NOT NULL,      -- 日次は YYYY-MM-DD、週次は YYYY-Www(JST)
  category   TEXT,               -- NULL = 全体
  headline   TEXT NOT NULL,
  json       TEXT NOT NULL,      -- episode の本体(記事の一覧・件数・図の数値)
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_kind_date ON episodes (kind, date);

-- ボード: 未読 / 読む(reading) / 試す(try) / 保留(hold)。「未読」は行が無い状態
CREATE TABLE IF NOT EXISTS board (
  url_hash   TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
