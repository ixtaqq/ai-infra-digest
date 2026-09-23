CREATE OR REPLACE FUNCTION public.claim_telegram_update()
RETURNS TABLE(update_id BIGINT,payload JSONB) LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('telegram-inbox-claim',0));
  -- A crashed handler may already have changed settings or sent a reply.
  UPDATE public.telegram_inbox SET status='ambiguous',payload=NULL,completed_at=CURRENT_TIMESTAMP
    WHERE status='processing' AND started_at<CURRENT_TIMESTAMP-INTERVAL '10 minutes';
  RETURN QUERY WITH candidate AS (
    SELECT i.update_id FROM public.telegram_inbox i WHERE i.status='pending'
      AND NOT EXISTS (SELECT 1 FROM public.telegram_inbox busy WHERE busy.chat_id=i.chat_id AND busy.status='processing')
    ORDER BY i.accepted_at,i.update_id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE public.telegram_inbox i SET status='processing',started_at=CURRENT_TIMESTAMP
    FROM candidate c WHERE i.update_id=c.update_id RETURNING i.update_id,i.payload;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_operational_data() RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.telegram_inbox SET payload=NULL,
    status=CASE WHEN status IN ('pending','processing') THEN 'ambiguous' ELSE status END,
    completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP)
    WHERE accepted_at<CURRENT_TIMESTAMP-INTERVAL '1 day';
  DELETE FROM public.telegram_inbox WHERE accepted_at<CURRENT_TIMESTAMP-INTERVAL '30 days' AND status='done';
  DELETE FROM public.email_verification_requests WHERE requested_at<CURRENT_TIMESTAMP-INTERVAL '1 day';
  RETURN TRUE;
END;
$$;
