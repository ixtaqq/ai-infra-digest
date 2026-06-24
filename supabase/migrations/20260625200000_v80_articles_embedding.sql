-- Enable pgvector (available on all Supabase projects)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to articles
ALTER TABLE articles ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- IVFFlat index for fast cosine similarity queries
-- lists=100 is suitable for tens of thousands of rows
CREATE INDEX IF NOT EXISTS idx_articles_embedding
  ON articles USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
