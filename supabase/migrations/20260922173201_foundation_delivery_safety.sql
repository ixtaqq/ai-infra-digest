ALTER TABLE public.alert_delivery_log DROP CONSTRAINT alert_delivery_log_status_check;
ALTER TABLE public.alert_delivery_log ADD CONSTRAINT alert_delivery_log_status_check
  CHECK (status IN ('pending', 'success', 'failed', 'ambiguous'));
CREATE OR REPLACE FUNCTION public.claim_high_impact_alert(
  p_chat_id BIGINT, p_content_hash TEXT, p_stale_after_seconds INTEGER DEFAULT 1800
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE claimed BOOLEAN;
BEGIN
  IF p_chat_id <= 0 OR p_content_hash !~ '^[0-9a-f]{64}$' THEN RETURN FALSE; END IF;
  INSERT INTO public.alert_delivery_log(chat_id, content_hash, status, claimed_at)
  VALUES(p_chat_id, p_content_hash, 'pending', CURRENT_TIMESTAMP)
  ON CONFLICT(chat_id, content_hash) DO UPDATE SET status = 'pending', claimed_at = CURRENT_TIMESTAMP
    WHERE public.alert_delivery_log.status = 'failed'
  RETURNING TRUE INTO claimed;
  RETURN COALESCE(claimed, FALSE);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_high_impact_alert(BIGINT,TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_high_impact_alert(BIGINT,TEXT,INTEGER) TO service_role;

ALTER TABLE public.user_preferences ADD COLUMN watchlist_mode TEXT NOT NULL DEFAULT 'prioritize'
  CHECK (watchlist_mode IN ('prioritize','only'));
ALTER TABLE public.price_watches ADD COLUMN revision UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.product_events DROP CONSTRAINT product_events_event_name_check;
ALTER TABLE public.product_events ADD CONSTRAINT product_events_event_name_check CHECK (event_name IN
  ('onboarding_started','onboarding_completed','delivery_resumed','delivery_succeeded','delivery_failed','briefing_retrieved','research_used'));

CREATE FUNCTION public.latest_feed_health()
RETURNS TABLE(feed_name TEXT,status TEXT,articles_fetched INTEGER,created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT DISTINCT ON (h.feed_name) h.feed_name,h.status,h.articles_fetched,h.created_at
  FROM public.pipeline_health h ORDER BY h.feed_name,h.created_at DESC,h.id DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.latest_feed_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.latest_feed_health() TO anon,authenticated,service_role;

CREATE TABLE public.email_verification_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  destination_hash TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON public.email_verification_requests(chat_id,requested_at);
CREATE INDEX ON public.email_verification_requests(destination_hash,requested_at);
ALTER TABLE public.email_verification_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_verification_requests FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.email_verification_requests TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.email_verification_requests_id_seq TO service_role;

CREATE FUNCTION public.request_delivery_email(p_chat_id BIGINT,p_email TEXT,p_code_hash TEXT,p_destination_hash TEXT,p_expires_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_chat_id IS NULL OR p_chat_id <= 0 OR length(p_email) NOT BETWEEN 3 AND 320
    OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_destination_hash !~ '^[0-9a-f]{64}$'
    OR p_expires_at <= CURRENT_TIMESTAMP THEN RETURN FALSE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-user:' || p_chat_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('email-destination:' || p_destination_hash,0));
  IF EXISTS (SELECT 1 FROM public.email_verification_requests WHERE chat_id=p_chat_id AND requested_at>CURRENT_TIMESTAMP-INTERVAL '60 seconds')
    OR (SELECT count(*) FROM public.email_verification_requests WHERE destination_hash=p_destination_hash AND requested_at>CURRENT_TIMESTAMP-INTERVAL '1 hour')>=5
    THEN RETURN FALSE; END IF;
  INSERT INTO public.email_verification_requests(chat_id,destination_hash) VALUES(p_chat_id,p_destination_hash);
  INSERT INTO public.delivery_email_verifications(chat_id,email,code_hash,expires_at)
  VALUES(p_chat_id,p_email,p_code_hash,p_expires_at)
  ON CONFLICT(chat_id) DO UPDATE SET email=EXCLUDED.email,code_hash=EXCLUDED.code_hash,
    expires_at=EXCLUDED.expires_at,attempts=0,updated_at=CURRENT_TIMESTAMP;
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.request_delivery_email(BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_delivery_email(BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ) TO service_role;

CREATE TABLE public.telegram_inbox (
  update_id BIGINT PRIMARY KEY,
  chat_id BIGINT,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','ambiguous')),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
ALTER TABLE public.telegram_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_inbox FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.telegram_inbox TO service_role;
CREATE INDEX ON public.telegram_inbox(status,accepted_at);
CREATE FUNCTION public.accept_telegram_update(p_update_id BIGINT,p_chat_id BIGINT,p_payload JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.telegram_inbox(update_id,chat_id,payload) VALUES(p_update_id,p_chat_id,p_payload)
  ON CONFLICT(update_id) DO NOTHING;
  RETURN TRUE;
END;
$$;
CREATE FUNCTION public.claim_telegram_update()
RETURNS TABLE(update_id BIGINT,payload JSONB) LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- A crashed handler may already have changed settings or sent a reply.
  UPDATE public.telegram_inbox SET status='ambiguous'
    WHERE status='processing' AND started_at<CURRENT_TIMESTAMP-INTERVAL '10 minutes';
  RETURN QUERY WITH candidate AS (
    SELECT i.update_id FROM public.telegram_inbox i WHERE i.status='pending'
      AND NOT EXISTS (SELECT 1 FROM public.telegram_inbox busy WHERE busy.chat_id=i.chat_id AND busy.status='processing')
    ORDER BY i.accepted_at,i.update_id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE public.telegram_inbox i SET status='processing',started_at=CURRENT_TIMESTAMP
    FROM candidate c WHERE i.update_id=c.update_id RETURNING i.update_id,i.payload;
END;
$$;
CREATE FUNCTION public.finish_telegram_update(p_update_id BIGINT,p_status TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_status NOT IN ('done','ambiguous') THEN RETURN FALSE; END IF;
  UPDATE public.telegram_inbox SET status=p_status,completed_at=CURRENT_TIMESTAMP,payload=NULL
    WHERE update_id=p_update_id AND status='processing';
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_telegram_update(BIGINT,BIGINT,JSONB),public.claim_telegram_update(),public.finish_telegram_update(BIGINT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accept_telegram_update(BIGINT,BIGINT,JSONB),public.claim_telegram_update(),public.finish_telegram_update(BIGINT,TEXT) TO service_role;

CREATE TABLE public.editorial_jobs (
  editorial_date DATE PRIMARY KEY,
  owner UUID NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','published','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);
ALTER TABLE public.editorial_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.editorial_jobs FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.editorial_jobs TO service_role;
CREATE FUNCTION public.claim_editorial_run(p_date DATE,p_owner UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE claimed BOOLEAN;
BEGIN
  IF EXISTS(SELECT 1 FROM public.digest_publications WHERE publication_date=p_date) THEN RETURN FALSE; END IF;
  INSERT INTO public.editorial_jobs(editorial_date,owner,status) VALUES(p_date,p_owner,'running')
  ON CONFLICT(editorial_date) DO UPDATE SET status='running',owner=EXCLUDED.owner,started_at=CURRENT_TIMESTAMP,completed_at=NULL
    WHERE public.editorial_jobs.status='failed'
  RETURNING TRUE INTO claimed;
  RETURN COALESCE(claimed,FALSE);
END;
$$;
CREATE FUNCTION public.finish_editorial_run(p_date DATE,p_owner UUID,p_status TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_status NOT IN ('published','failed') THEN RETURN FALSE; END IF;
  UPDATE public.editorial_jobs SET status=p_status,completed_at=CURRENT_TIMESTAMP WHERE editorial_date=p_date AND owner=p_owner AND status='running';
  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_editorial_run(DATE,UUID),public.finish_editorial_run(DATE,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_editorial_run(DATE,UUID),public.finish_editorial_run(DATE,UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_user_data(p_chat_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_chat_id IS NULL OR p_chat_id <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.user_preferences
  SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
  WHERE chat_id = p_chat_id;

  DELETE FROM public.user_delivery_log WHERE chat_id = p_chat_id;
  DELETE FROM public.alert_delivery_log WHERE chat_id = p_chat_id;
  DELETE FROM public.product_events WHERE chat_id = p_chat_id;
  DELETE FROM public.price_watches WHERE chat_id = p_chat_id;
  DELETE FROM public.command_usage WHERE chat_id = p_chat_id;
  DELETE FROM public.article_validations WHERE chat_id = p_chat_id;
  DELETE FROM public.digest_feedback WHERE chat_id = p_chat_id;
  DELETE FROM public.delivery_email_verifications WHERE chat_id = p_chat_id;
  DELETE FROM public.email_verification_requests WHERE chat_id = p_chat_id;
  DELETE FROM public.telegram_inbox WHERE chat_id = p_chat_id;
  DELETE FROM public.user_preferences WHERE chat_id = p_chat_id;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_user_data(BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_data(BIGINT)
  TO service_role;
