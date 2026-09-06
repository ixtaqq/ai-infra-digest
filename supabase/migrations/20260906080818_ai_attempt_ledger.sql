CREATE TABLE public.ai_attempts (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  stage TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  prompt_tokens BIGINT CHECK (prompt_tokens >= 0),
  completion_tokens BIGINT CHECK (completion_tokens >= 0),
  total_tokens BIGINT CHECK (total_tokens >= 0),
  reported_cost NUMERIC CHECK (reported_cost >= 0)
);
CREATE INDEX ai_attempts_started_at_idx ON public.ai_attempts(started_at);
ALTER TABLE public.ai_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.ai_attempts TO service_role;
CREATE POLICY service_only ON public.ai_attempts TO service_role USING (true) WITH CHECK (true);
