-- v17: optional per-user destinations for personalized digest copies.
-- user_preferences is service-role-only, so Slack webhook URLs are never exposed
-- through the public dashboard/anon API.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS delivery_email TEXT,
  ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT;

COMMENT ON COLUMN user_preferences.delivery_email IS
  'Optional recipient for a personalized email copy; Telegram remains the primary channel.';
COMMENT ON COLUMN user_preferences.slack_webhook_url IS
  'Optional private Slack Incoming Webhook for a personalized copy; never expose through anon clients.';
