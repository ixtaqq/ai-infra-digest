-- v6.3: Devil's Advocate — add bear_case column to articles
ALTER TABLE articles ADD COLUMN IF NOT EXISTS bear_case TEXT;
