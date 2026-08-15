-- Preserve explicit onboarding consent so paused users can resume delivery
-- without repeating setup, while incomplete onboarding remains inactive.

ALTER TABLE public.user_preferences
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ;

UPDATE public.user_preferences
SET onboarding_completed_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
WHERE is_active = TRUE
  AND onboarding_completed_at IS NULL;

COMMENT ON COLUMN public.user_preferences.onboarding_completed_at IS
  'Timestamp of explicit onboarding completion; required for direct /resume activation.';
