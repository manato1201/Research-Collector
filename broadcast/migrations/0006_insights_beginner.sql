-- ResearchBroadcast: 解説を「初心者・聞き手向け」にする(日本語ベース)
--   title_ja     題名の自然な日本語の見出し(英語の題名を、そのまま読み上げないため)
--   term / term_meaning  初心者がつまずきそうな用語を1つ、やさしく説明する(「今日の用語ひとこと」)
--   ver          解説の版。版が古い行は、再生成の対象にする(1 = 初版、2 = 初心者向け)
-- source に 'title' を追加: 要約が無い英語の記事に、日本語の見出しだけを付けたもの(what / use / apply は無い)

ALTER TABLE insights ADD COLUMN title_ja TEXT;
ALTER TABLE insights ADD COLUMN term TEXT;
ALTER TABLE insights ADD COLUMN term_meaning TEXT;
ALTER TABLE insights ADD COLUMN ver INTEGER NOT NULL DEFAULT 1;
