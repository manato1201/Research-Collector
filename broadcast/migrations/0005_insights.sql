-- ResearchBroadcast: 記事の「解説」(これは何か / 何ができるか / どう応用できるか)
-- 生成は Workers AI(無料枠)。根拠は題名と要約だけ。AI が書いたものとして、source に残す。

CREATE TABLE IF NOT EXISTS insights (
  url_hash   TEXT PRIMARY KEY,
  what       TEXT,               -- これは何か
  use        TEXT,               -- 読むと何ができるか
  apply      TEXT,               -- どう応用できるか
  source     TEXT NOT NULL,      -- ai = 生成できた / none = 生成を試したが使える出力にならなかった(再試行しない)
  model      TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_insights_created ON insights (created_at);
