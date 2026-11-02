-- Lets an operator release an editorial claim whose worker died. The hour guard
-- exceeds the daily workflow's 45-minute timeout, so a CI worker cannot still own it.
CREATE FUNCTION public.release_editorial_run(p_date DATE, p_reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  released_owner UUID;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 20 THEN RETURN FALSE; END IF;
  UPDATE public.editorial_jobs
    SET status = 'failed', completed_at = CURRENT_TIMESTAMP
    WHERE editorial_date = p_date
      AND status = 'running'
      AND started_at < CURRENT_TIMESTAMP - INTERVAL '1 hour'
    RETURNING owner INTO released_owner;
  IF released_owner IS NULL THEN RETURN FALSE; END IF;
  INSERT INTO public.reconciliation_audit(target, identity, previous_status, resolved_status, reason)
    VALUES ('editorial', jsonb_build_object('date', p_date, 'owner', released_owner), 'running', 'failed', p_reason);
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.release_editorial_run(DATE, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_editorial_run(DATE, TEXT) TO service_role;
