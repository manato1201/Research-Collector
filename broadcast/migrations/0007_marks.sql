-- ResearchBroadcast: ピンと「見直す日」(整理の仕組み。外部資料 第5弾 Z35)
-- ボードの状態(読む / 試す / 保留 / 既読)とは別の目印。記事を「未読のまま残す」ときの、
--   pinned    = 1: 残しておく(整理の候補から外す)
--   remind_on = 見直す日(JST の日付 YYYY-MM-DD。その日から「見直し」に出る。通知は出さない)
-- 行があるのは、どちらかが付いている記事だけ(両方外れたら行ごと消す)。記事が保持期間を過ぎて消えたら、行も消える。
CREATE TABLE IF NOT EXISTS marks (
  url_hash   TEXT PRIMARY KEY,
  pinned     INTEGER NOT NULL DEFAULT 0,
  remind_on  TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marks_remind ON marks (remind_on);
