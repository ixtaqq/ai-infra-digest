-- Delivery claims are short-lived leases. A successful row remains terminal;
-- failed rows can retry immediately and pending rows can be reclaimed after a
-- scheduler process has gone stale.

ALTER TABLE public.user_delivery_log
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE public.user_delivery_log
  DROP CONSTRAINT IF EXISTS user_delivery_log_status_check;

ALTER TABLE public.user_delivery_log
  ADD CONSTRAINT user_delivery_log_status_check
  CHECK (status IN ('pending', 'success', 'failed'));

CREATE INDEX IF NOT EXISTS idx_delivery_log_claim_state
  ON public.user_delivery_log(status, claimed_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.claim_user_delivery(
  p_chat_id BIGINT,
  p_run_date DATE,
  p_stale_after_seconds INTEGER DEFAULT 1800
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  did_claim BOOLEAN;
BEGIN
  INSERT INTO public.user_delivery_log (
    chat_id,
    run_date,
    status,
    details,
    claimed_at
  )
  VALUES (
    p_chat_id,
    p_run_date,
    'pending',
    'claimed — send in progress',
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (chat_id, run_date) DO UPDATE
  SET
    status = 'pending',
    details = 'claimed — send in progress',
    claimed_at = CURRENT_TIMESTAMP
  WHERE public.user_delivery_log.status = 'failed'
     OR (
       public.user_delivery_log.status = 'pending'
       AND (
         public.user_delivery_log.claimed_at IS NULL
         OR public.user_delivery_log.claimed_at < CURRENT_TIMESTAMP -
           GREATEST(p_stale_after_seconds, 1) * INTERVAL '1 second'
       )
     )
  RETURNING TRUE INTO did_claim;

  RETURN COALESCE(did_claim, FALSE);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_user_delivery(BIGINT, DATE, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_user_delivery(BIGINT, DATE, INTEGER)
  TO service_role;
