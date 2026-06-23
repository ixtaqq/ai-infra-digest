-- ============================================================
-- Migration v2.0: Add alert system fields to user_preferences
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Add alert notification columns (safe to run even if they already exist)
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS alerts_min_score INT DEFAULT 8 
    CHECK (alerts_min_score >= 1 AND alerts_min_score <= 10);

-- Verify the columns were added
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'user_preferences' 
  AND column_name IN ('alerts_enabled', 'alerts_min_score');
