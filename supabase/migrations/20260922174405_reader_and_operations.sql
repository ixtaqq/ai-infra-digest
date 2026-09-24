CREATE TABLE public.public_editions (
  publication_date DATE PRIMARY KEY,
  published_at TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,
  market_outlook TEXT NOT NULL,
  articles JSONB NOT NULL
);
ALTER TABLE public.public_editions ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_read ON public.public_editions FOR SELECT TO anon,authenticated USING (true);
REVOKE ALL ON public.public_editions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.public_editions TO anon,authenticated;
GRANT ALL ON public.public_editions TO service_role;

CREATE FUNCTION public.publish_reader_edition() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.public_editions(publication_date,published_at,summary,market_outlook,articles)
  SELECT NEW.publication_date,NEW.published_at,COALESCE(NEW.payload->'digest'->>'summary',''),
    COALESCE(NEW.payload->'digest'->>'marketOutlook',''),COALESCE(jsonb_agg(jsonb_build_object(
      'title',a->>'title','url',a->>'url','source',a->>'source','summary',a->>'summary',
      'impact',a->>'impact','impactScore',a->'impactScore','effectiveScore',a->'effectiveScore',
      'affectedStocks',a->'affectedStocks','category',a->>'category','reason',a->>'reason','bearCase',a->>'bearCase'
    )),'[]'::jsonb)
  FROM jsonb_array_elements(NEW.payload->'digest'->'articles') a
  ON CONFLICT(publication_date) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.publish_reader_edition() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_reader_edition() TO service_role;
CREATE TRIGGER reader_edition_after_publish AFTER INSERT ON public.digest_publications
  FOR EACH ROW EXECUTE FUNCTION public.publish_reader_edition();
INSERT INTO public.public_editions(publication_date,published_at,summary,market_outlook,articles)
SELECT p.publication_date,p.published_at,COALESCE(p.payload->'digest'->>'summary',''),
  COALESCE(p.payload->'digest'->>'marketOutlook',''),COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'title',a->>'title','url',a->>'url','source',a->>'source','summary',a->>'summary',
    'impact',a->>'impact','impactScore',a->'impactScore','effectiveScore',a->'effectiveScore',
    'affectedStocks',a->'affectedStocks','category',a->>'category','reason',a->>'reason','bearCase',a->>'bearCase'
  )) FROM jsonb_array_elements(p.payload->'digest'->'articles') a),'[]'::jsonb)
FROM public.digest_publications p ON CONFLICT(publication_date) DO NOTHING;

CREATE FUNCTION public.stock_mentions_summary(p_since DATE)
RETURNS TABLE(ticker TEXT,mention_count BIGINT,price_change_percent NUMERIC)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.ticker,sum(s.mention_count)::bigint,(array_agg(s.price_change_percent ORDER BY s.date DESC))[1]
  FROM public.stock_mentions s WHERE s.date>=p_since GROUP BY s.ticker
  ORDER BY sum(s.mention_count) DESC,s.ticker LIMIT 10;
$$;
REVOKE EXECUTE ON FUNCTION public.stock_mentions_summary(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stock_mentions_summary(DATE) TO anon,authenticated,service_role;

CREATE TABLE public.reconciliation_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target TEXT NOT NULL, identity JSONB NOT NULL, previous_status TEXT NOT NULL,
  resolved_status TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(reason)>=20),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.reconciliation_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reconciliation_audit FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.reconciliation_audit TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.reconciliation_audit_id_seq TO service_role;
CREATE FUNCTION public.reconcile_delivery(p_target TEXT,p_id BIGINT,p_status TEXT,p_reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous TEXT;
BEGIN
  IF p_status NOT IN ('success','failed') OR p_reason IS NULL OR length(trim(p_reason))<20 THEN RETURN FALSE; END IF;
  IF p_target='digest' THEN
    SELECT status INTO previous FROM public.user_delivery_log WHERE id=p_id FOR UPDATE;
    IF previous NOT IN ('pending','ambiguous') OR previous IS NULL THEN RETURN FALSE; END IF;
    UPDATE public.user_delivery_log SET status=p_status,details=p_reason WHERE id=p_id;
  ELSIF p_target='alert' THEN
    SELECT status INTO previous FROM public.alert_delivery_log WHERE id=p_id FOR UPDATE;
    IF previous NOT IN ('pending','ambiguous') OR previous IS NULL THEN RETURN FALSE; END IF;
    UPDATE public.alert_delivery_log SET status=p_status,details=p_reason WHERE id=p_id;
  ELSE RETURN FALSE;
  END IF;
  INSERT INTO public.reconciliation_audit(target,identity,previous_status,resolved_status,reason)
    VALUES(p_target,jsonb_build_object('id',p_id),previous,p_status,p_reason);
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reconcile_delivery(TEXT,BIGINT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_delivery(TEXT,BIGINT,TEXT,TEXT) TO service_role;

CREATE FUNCTION public.cleanup_operational_data() RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.telegram_inbox SET payload=NULL WHERE accepted_at<CURRENT_TIMESTAMP-INTERVAL '1 day';
  DELETE FROM public.telegram_inbox WHERE accepted_at<CURRENT_TIMESTAMP-INTERVAL '30 days' AND status='done';
  DELETE FROM public.email_verification_requests WHERE requested_at<CURRENT_TIMESTAMP-INTERVAL '1 day';
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cleanup_operational_data() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_operational_data() TO service_role;

CREATE TABLE public.ai_model_prices (
  endpoint TEXT NOT NULL, model TEXT NOT NULL,
  input_per_million NUMERIC NOT NULL CHECK(input_per_million>=0),
  output_per_million NUMERIC NOT NULL CHECK(output_per_million>=0),
  max_input_tokens INTEGER NOT NULL CHECK(max_input_tokens>0),
  reviewed_until TIMESTAMPTZ NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY(endpoint,model)
);
CREATE TABLE public.ai_budget_reservations (
  id UUID PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reserved_cost NUMERIC NOT NULL CHECK(reserved_cost>=0), charged_cost NUMERIC NOT NULL CHECK(charged_cost>=0),
  input_per_million NUMERIC NOT NULL, output_per_million NUMERIC NOT NULL,
  settled_at TIMESTAMPTZ
);
ALTER TABLE public.ai_model_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_model_prices,public.ai_budget_reservations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.ai_model_prices,public.ai_budget_reservations TO service_role;
CREATE INDEX ON public.ai_budget_reservations(started_at);
CREATE FUNCTION public.reserve_ai_attempt(p_id UUID,p_endpoint TEXT,p_model TEXT,p_output_limit INTEGER,p_daily_cap NUMERIC,p_monthly_cap NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE price public.ai_model_prices%ROWTYPE; amount NUMERIC; day_total NUMERIC; month_total NUMERIC;
BEGIN
  IF p_daily_cap IS NULL OR p_monthly_cap IS NULL OR p_daily_cap<0 OR p_monthly_cap<0 OR p_output_limit<0 THEN RETURN FALSE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-budget-reservations',0));
  SELECT * INTO price FROM public.ai_model_prices WHERE endpoint=p_endpoint AND model=p_model AND reviewed_until>CURRENT_TIMESTAMP;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  amount=(price.max_input_tokens*price.input_per_million+p_output_limit*price.output_per_million)/1000000;
  SELECT COALESCE(sum(charged_cost) FILTER (WHERE started_at>=date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0),
    COALESCE(sum(charged_cost),0) INTO day_total,month_total FROM public.ai_budget_reservations WHERE started_at>CURRENT_TIMESTAMP-INTERVAL '30 days';
  -- Include advisory attempts preceding the switch to enforcement.
  SELECT day_total+COALESCE(sum(reported_cost) FILTER (WHERE started_at>=date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0),
    month_total+COALESCE(sum(reported_cost),0) INTO day_total,month_total
    FROM public.ai_attempts a WHERE started_at>CURRENT_TIMESTAMP-INTERVAL '30 days'
      AND NOT EXISTS(SELECT 1 FROM public.ai_budget_reservations r WHERE r.id=a.id);
  IF EXISTS(SELECT 1 FROM public.ai_attempts a WHERE started_at>CURRENT_TIMESTAMP-INTERVAL '30 days' AND reported_cost IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.ai_budget_reservations r WHERE r.id=a.id)) THEN RETURN FALSE; END IF;
  IF day_total+amount>p_daily_cap OR month_total+amount>p_monthly_cap THEN RETURN FALSE; END IF;
  INSERT INTO public.ai_budget_reservations(id,reserved_cost,charged_cost,input_per_million,output_per_million)
    VALUES(p_id,amount,amount,price.input_per_million,price.output_per_million);
  RETURN TRUE;
END;
$$;
CREATE FUNCTION public.settle_ai_attempt(p_id UUID,p_cost NUMERIC,p_prompt INTEGER,p_completion INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.ai_budget_reservations SET charged_cost=CASE
    WHEN p_cost>=0 THEN p_cost
    WHEN p_prompt>=0 AND p_completion>=0 THEN (p_prompt*input_per_million+p_completion*output_per_million)/1000000
    ELSE reserved_cost END,settled_at=CURRENT_TIMESTAMP WHERE id=p_id AND settled_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reserve_ai_attempt(UUID,TEXT,TEXT,INTEGER,NUMERIC,NUMERIC),public.settle_ai_attempt(UUID,NUMERIC,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_attempt(UUID,TEXT,TEXT,INTEGER,NUMERIC,NUMERIC),public.settle_ai_attempt(UUID,NUMERIC,INTEGER,INTEGER) TO service_role;
