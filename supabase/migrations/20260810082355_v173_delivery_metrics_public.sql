-- v17.3: expose delivery performance without exposing Telegram chat IDs or
-- per-user delivery details. A service-role trigger maintains daily aggregates
-- whenever the private delivery log changes.

CREATE TABLE IF NOT EXISTS public.delivery_metrics_daily (
  run_date DATE PRIMARY KEY,
  total_deliveries INT NOT NULL DEFAULT 0 CHECK (total_deliveries >= 0),
  successful_deliveries INT NOT NULL DEFAULT 0 CHECK (successful_deliveries >= 0),
  failed_deliveries INT NOT NULL DEFAULT 0 CHECK (failed_deliveries >= 0),
  unique_users INT NOT NULL DEFAULT 0 CHECK (unique_users >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.delivery_metrics_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read" ON public.delivery_metrics_daily;
DROP POLICY IF EXISTS "service_role_write" ON public.delivery_metrics_daily;
CREATE POLICY "public_read" ON public.delivery_metrics_daily
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_role_write" ON public.delivery_metrics_daily
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.delivery_metrics_daily FROM anon, authenticated;
GRANT SELECT ON TABLE public.delivery_metrics_daily TO anon, authenticated;
GRANT ALL ON TABLE public.delivery_metrics_daily TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_delivery_metrics_daily()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  metric_date DATE;
BEGIN
  FOR metric_date IN
    SELECT DISTINCT candidate_date
    FROM (
      VALUES
        (CASE WHEN TG_OP <> 'INSERT' THEN OLD.run_date END),
        (CASE WHEN TG_OP <> 'DELETE' THEN NEW.run_date END)
    ) AS candidate_dates(candidate_date)
    WHERE candidate_date IS NOT NULL
  LOOP
    DELETE FROM public.delivery_metrics_daily
    WHERE run_date = metric_date;

    INSERT INTO public.delivery_metrics_daily (
      run_date,
      total_deliveries,
      successful_deliveries,
      failed_deliveries,
      unique_users,
      updated_at
    )
    SELECT
      metric_date,
      COUNT(*)::INT,
      COUNT(*) FILTER (WHERE status = 'success')::INT,
      COUNT(*) FILTER (WHERE status = 'failed')::INT,
      COUNT(DISTINCT chat_id)::INT,
      NOW()
    FROM public.user_delivery_log
    WHERE run_date = metric_date
    HAVING COUNT(*) > 0;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_delivery_metrics_daily()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_delivery_metrics_daily()
  TO service_role;

DROP TRIGGER IF EXISTS refresh_delivery_metrics_daily_trigger
  ON public.user_delivery_log;
CREATE TRIGGER refresh_delivery_metrics_daily_trigger
AFTER INSERT OR DELETE OR UPDATE OF status, run_date, chat_id
ON public.user_delivery_log
FOR EACH ROW
EXECUTE FUNCTION public.refresh_delivery_metrics_daily();

INSERT INTO public.delivery_metrics_daily (
  run_date,
  total_deliveries,
  successful_deliveries,
  failed_deliveries,
  unique_users,
  updated_at
)
SELECT
  run_date,
  COUNT(*)::INT,
  COUNT(*) FILTER (WHERE status = 'success')::INT,
  COUNT(*) FILTER (WHERE status = 'failed')::INT,
  COUNT(DISTINCT chat_id)::INT,
  NOW()
FROM public.user_delivery_log
GROUP BY run_date
ON CONFLICT (run_date) DO UPDATE SET
  total_deliveries = EXCLUDED.total_deliveries,
  successful_deliveries = EXCLUDED.successful_deliveries,
  failed_deliveries = EXCLUDED.failed_deliveries,
  unique_users = EXCLUDED.unique_users,
  updated_at = EXCLUDED.updated_at;
