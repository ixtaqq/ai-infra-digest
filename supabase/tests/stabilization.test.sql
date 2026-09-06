BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;
SELECT no_plan();

SELECT ok(NOT has_table_privilege(role_name, 'public.ai_attempts', 'SELECT'), role_name || ' cannot read AI attempts')
FROM unnest(ARRAY['anon','authenticated']) role_name;
SELECT ok(NOT has_function_privilege(role_name, 'public.claim_user_delivery(bigint,date,integer)', 'EXECUTE'), role_name || ' cannot claim delivery')
FROM unnest(ARRAY['anon','authenticated']) role_name;

SET LOCAL ROLE anon;
SELECT throws_ok('SELECT * FROM public.user_preferences', '42501', NULL, 'anonymous users cannot read personal settings');
SELECT throws_ok('SELECT * FROM public.user_delivery_log', '42501', NULL, 'anonymous users cannot read delivery state');
SELECT throws_ok('SELECT * FROM public.ai_attempts', '42501', NULL, 'anonymous users cannot read attempts');
SELECT lives_ok('SELECT id,title,url FROM public.articles LIMIT 1', 'public research columns remain readable');
SELECT throws_ok('INSERT INTO public.articles(title) VALUES (''forbidden'')', '42501', NULL, 'public role cannot write articles');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok('SELECT * FROM public.user_preferences', '42501', NULL, 'signed-in users cannot read personal settings');
SELECT throws_ok('SELECT * FROM public.user_delivery_log', '42501', NULL, 'signed-in users cannot read delivery state');
SELECT throws_ok('SELECT public.claim_user_delivery(987654321, CURRENT_DATE)', '42501', NULL, 'signed-in users cannot claim delivery');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT ok(public.claim_user_delivery(987654321, '2099-01-01'), 'first worker claims slot');
SELECT ok(NOT public.claim_user_delivery(987654321, '2099-01-01'), 'overlapping worker cannot claim slot');
UPDATE public.user_delivery_log SET claimed_at = NOW() - INTERVAL '2 days' WHERE chat_id = 987654321;
SELECT ok(NOT public.claim_user_delivery(987654321, '2099-01-01'), 'stale pending send is not blindly replayed');
UPDATE public.user_delivery_log SET status = 'ambiguous' WHERE chat_id = 987654321;
SELECT ok(NOT public.claim_user_delivery(987654321, '2099-01-01'), 'ambiguous outcome requires reconciliation');
UPDATE public.user_delivery_log SET status = 'failed' WHERE chat_id = 987654321;
SELECT ok(public.claim_user_delivery(987654321, '2099-01-01'), 'confirmed failed send may retry');
UPDATE public.user_delivery_log SET status = 'success' WHERE chat_id = 987654321;
SELECT ok(NOT public.claim_user_delivery(987654321, '2099-01-01'), 'success stays terminal');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
