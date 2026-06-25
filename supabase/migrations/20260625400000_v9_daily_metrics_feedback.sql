-- v9: add feedback_ratings column to daily_metrics
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS feedback_ratings TEXT;
