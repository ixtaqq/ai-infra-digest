-- New preference rows must remain inactive until onboarding completes.
ALTER TABLE public.user_preferences
  ALTER COLUMN is_active SET DEFAULT FALSE;

-- v18.1 initially inferred completion from legacy active state. The old bot did
-- not require the final onboarding step, so that inference was not proof of
-- consent. New completions are written explicitly by the application.
UPDATE public.user_preferences
SET onboarding_completed_at = NULL
WHERE onboarding_completed_at IS NOT NULL;

ALTER TABLE public.product_events
  DROP CONSTRAINT product_events_event_name_check;

ALTER TABLE public.product_events
  ADD CONSTRAINT product_events_event_name_check CHECK (
    event_name IN (
      'onboarding_started',
      'onboarding_completed',
      'delivery_resumed',
      'delivery_succeeded',
      'delivery_failed'
    )
  );
