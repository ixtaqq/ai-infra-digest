-- Older migrations relied on Supabase's former automatic service-role grants.
-- Keep client grants unchanged and grant the worker its explicit persistence access.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.ai_usage, public.articles, public.capex_tracking, public.command_usage,
  public.daily_metrics, public.digest_runs, public.pipeline_health,
  public.price_watches, public.sector_activity, public.stock_mentions,
  public.stock_prices, public.ticker_theses, public.ticker_thesis_history
TO service_role;

DO $$
DECLARE table_name TEXT; sequence_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ai_usage','articles','capex_tracking','command_usage',
    'daily_metrics','digest_runs','pipeline_health','price_watches','sector_activity',
    'stock_mentions','stock_prices','ticker_theses','ticker_thesis_history'] LOOP
    sequence_name := pg_get_serial_sequence('public.' || table_name, 'id');
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', sequence_name);
    END IF;
  END LOOP;
END;
$$;
