-- GitHub's schedule trigger ran the 10-minute delivery job about every 4.4 hours
-- (median, October 2026). pg_cron asks GitHub to run the workflows on time.
-- Until the Vault secret below exists, each dispatch is a logged no-op.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.dispatch_github_workflow(p_workflow TEXT)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  token TEXT;
BEGIN
  SELECT decrypted_secret INTO token
    FROM vault.decrypted_secrets
    WHERE name = 'github_actions_dispatch_token';
  IF token IS NULL THEN
    RAISE WARNING 'github_actions_dispatch_token is not in Vault; % was not dispatched', p_workflow;
    RETURN NULL;
  END IF;
  RETURN net.http_post(
    url := 'https://api.github.com/repos/ixtaqq/ai-infra-digest/actions/workflows/' || p_workflow || '/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'ai-infra-digest-pg-cron',
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 10000
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION private.dispatch_github_workflow(TEXT) FROM PUBLIC, anon, authenticated, service_role;

SELECT cron.schedule('dispatch-scheduled-delivery', '*/10 * * * *',
  $$SELECT private.dispatch_github_workflow('scheduled-delivery.yml')$$);
SELECT cron.schedule('dispatch-daily-digest', '17 22 * * *',
  $$SELECT private.dispatch_github_workflow('daily-digest.yml')$$);
SELECT cron.schedule('prune-cron-history', '0 3 * * 0',
  $$DELETE FROM cron.job_run_details WHERE end_time < CURRENT_TIMESTAMP - INTERVAL '14 days'$$);
