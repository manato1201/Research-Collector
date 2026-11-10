-- ResearchBroadcast: 複数人で使うための「持ち主(owner)」。2026-11-10(QUALITY_UPLIFT §1.8 の A6)
--
-- ボード・ピン/見直す日・設定は、これまで全員で 1 つ(1 人用)だった。Cloudflare Access で複数人が入ると、
-- 互いの既読・メモ・設定を上書きしてしまう。そこで、この 3 つのテーブルに owner を足し、(owner, キー)で 1 行にする。
--   owner = ''          : 従来の 1 人用の持ち主。Bearer(機械)・パスワードのログイン・READ_REQUIRES_TOKEN=false で使う。既存の行は全部ここに入る
--   owner = <メール>    : Cloudflare Access で入った人(小文字)
-- 記事・episode・レポートは全員で共有のまま(収集物は共通。個人のものは、この 3 つだけ)。
--
-- 注意: サイト(Worker)を更新する前に適用すること(新しいコードは owner 列を使う)。

CREATE TABLE board_new (
  owner      TEXT NOT NULL DEFAULT '',
  url_hash   TEXT NOT NULL,
  state      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, url_hash)
);
INSERT INTO board_new (owner, url_hash, state, note, updated_at)
  SELECT '', url_hash, state, note, updated_at FROM board;
DROP TABLE board;
ALTER TABLE board_new RENAME TO board;

CREATE TABLE marks_new (
  owner      TEXT NOT NULL DEFAULT '',
  url_hash   TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  remind_on  TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, url_hash)
);
INSERT INTO marks_new (owner, url_hash, pinned, remind_on, updated_at)
  SELECT '', url_hash, pinned, remind_on, updated_at FROM marks;
DROP TABLE marks;
ALTER TABLE marks_new RENAME TO marks;
CREATE INDEX IF NOT EXISTS idx_marks_remind ON marks (owner, remind_on);

CREATE TABLE prefs_new (
  owner      TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,       -- watchwords / muted_sources / projects
  value      TEXT NOT NULL,       -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, key)
);
INSERT INTO prefs_new (owner, key, value, updated_at)
  SELECT '', key, value, updated_at FROM prefs;
DROP TABLE prefs;
ALTER TABLE prefs_new RENAME TO prefs;
