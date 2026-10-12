-- ResearchBroadcast: 週次レポート(ダイジェスト)と、配布サイトの新着ウォッチ(通知のみ)
-- 無料プランの構成のまま、D1 に直接保存する(レポートは1件 最大300KB、実測は約25KB)。

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,   -- digest:YYYY-MM-DD。再送は上書き(冪等)
  kind       TEXT NOT NULL,      -- digest
  date       TEXT NOT NULL,
  title      TEXT NOT NULL,
  json       TEXT NOT NULL,      -- {week, generated_at, intro, sections:[{category, heading, markdown}]}
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_date ON reports (date);

CREATE TABLE IF NOT EXISTS watch (
  url         TEXT PRIMARY KEY,
  watch       TEXT NOT NULL,     -- 監視名(例: skills.sh)
  title       TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watch_detected ON watch (detected_at);
