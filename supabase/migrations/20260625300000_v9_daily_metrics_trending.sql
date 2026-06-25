-- v9: add trending columns to daily_metrics
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS trending_json TEXT;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS trending_entities TEXT;
