-- ResearchBroadcast: 設定(ウォッチワード・関連プロジェクト・非表示の収集元)と、記事の全文検索
-- 無料プランの構成のまま、D1 だけで動く(FTS5 は D1 が対応している)。

CREATE TABLE IF NOT EXISTS prefs (
  key        TEXT PRIMARY KEY,   -- watchwords / muted_sources / projects
  value      TEXT NOT NULL,      -- JSON
  updated_at TEXT NOT NULL
);

-- 全文検索。trigram トークナイザは、日本語も「部分一致」で探せる(3文字以上。短い語は API 側で LIKE にする)。
-- 外部コンテンツ表(articles を指す)なので、本文は二重に持たない。articles の増減は下のトリガで追従する。
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  summary,
  content = 'articles',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS articles_fts_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (rowid, title, summary) VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
  INSERT INTO articles_fts (rowid, title, summary) VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
END;

-- すでにある記事を索引にする
INSERT INTO articles_fts (articles_fts) VALUES ('rebuild');
