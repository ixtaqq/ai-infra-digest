BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;
SELECT no_plan();

SELECT ok(NOT has_table_privilege(r, 'public.' || t, 'SELECT'), r || ' cannot read ' || t)
FROM unnest(ARRAY['anon','authenticated']) r CROSS JOIN unnest(ARRAY['telegram_inbox','editorial_jobs','email_verification_requests','reconciliation_audit','ai_model_prices','ai_budget_reservations']) t;
SET LOCAL ROLE anon;
SELECT lives_ok('SELECT * FROM public.public_editions LIMIT 1', 'public editions are readable');
SELECT lives_ok('SELECT * FROM public.latest_feed_health()', 'feed health uses readable columns');
SELECT lives_ok('SELECT * FROM public.stock_mentions_summary(CURRENT_DATE)', 'mention aggregation is readable');
SELECT throws_ok('SELECT public.claim_telegram_update()', '42501', NULL, 'public cannot process commands');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT ok(has_table_privilege('service_role', 'public.' || t, permission), 'worker persistence access: ' || t || ' ' || permission)
FROM unnest(ARRAY['ai_usage','articles','capex_tracking','command_usage','daily_metrics','digest_runs','pipeline_health','price_watches','sector_activity','stock_mentions','stock_prices','ticker_theses','ticker_thesis_history']) t
CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) permission;
SELECT lives_ok($sql$INSERT INTO public.digest_publications(publication_date,schema_version,payload) VALUES('2099-01-03',1,'{"digest":{"summary":"Fixture","marketOutlook":"Mixed","articles":[{"title":"Public title","url":"https://example.com","rawText":"PRIVATE RAW","embedding":[1,2]}]},"private":"PRIVATE FIELD"}')$sql$, 'publication creates public projection');
SELECT is((SELECT articles->0->>'title' FROM public.public_editions WHERE publication_date='2099-01-03'),'Public title','projection preserves reader fields');
SELECT ok((SELECT NOT (articles->0 ? 'rawText') AND NOT (articles->0 ? 'embedding') FROM public.public_editions WHERE publication_date='2099-01-03'),'projection omits private source and embedding fields');
SELECT ok(public.claim_high_impact_alert(987654322,repeat('a',64)), 'alert claim succeeds once');
UPDATE public.alert_delivery_log SET claimed_at=NOW()-INTERVAL '2 days' WHERE chat_id=987654322;
SELECT ok(NOT public.claim_high_impact_alert(987654322,repeat('a',64)), 'stale pending alert stays quarantined');
UPDATE public.alert_delivery_log SET status='ambiguous' WHERE chat_id=987654322;
SELECT ok(NOT public.claim_high_impact_alert(987654322,repeat('a',64)), 'ambiguous alert cannot replay');
SELECT ok(public.reconcile_delivery('alert',(SELECT id FROM public.alert_delivery_log WHERE chat_id=987654322),'failed','Provider confirmed this message was never accepted'), 'evidenced reconciliation succeeds');
SELECT ok(public.claim_high_impact_alert(987654322,repeat('a',64)), 'confirmed failure may retry');

SELECT ok(public.request_delivery_email(987654322,'fixture@example.com',repeat('a',64),repeat('b',64),NOW()+INTERVAL '10 minutes'), 'verification request accepted');
SELECT ok(NOT public.request_delivery_email(987654322,'fixture@example.com',repeat('a',64),repeat('b',64),NOW()+INTERVAL '10 minutes'), 'verification cooldown enforced');
SELECT ok(public.accept_telegram_update(987654320,987654322,'{"message":"private fixture"}'), 'inbox accepts update');
SELECT ok(public.accept_telegram_update(987654320,987654322,'{"message":"duplicate"}'), 'duplicate acknowledged');
SELECT is((SELECT count(*)::int FROM public.telegram_inbox WHERE update_id=987654320),1,'duplicate does not insert twice');
SELECT is((SELECT update_id FROM public.claim_telegram_update()),987654320::bigint,'worker claims accepted update');
SELECT ok(public.accept_telegram_update(987654321,987654322,'{}'), 'second update accepted');
SELECT is((SELECT count(*)::int FROM public.claim_telegram_update()),0,'chat processing is serialized');
SELECT ok(public.finish_telegram_update(987654320,'done'),'completion recorded');
SELECT ok((SELECT payload IS NULL FROM public.telegram_inbox WHERE update_id=987654320),'completed sensitive payload erased');
SELECT is((SELECT update_id FROM public.claim_telegram_update()),987654321::bigint,'next command can run');
UPDATE public.telegram_inbox SET started_at=NOW()-INTERVAL '11 minutes' WHERE update_id=987654321;
SELECT is((SELECT count(*)::int FROM public.claim_telegram_update()),0,'abandoned handler not replayed');
SELECT is((SELECT status FROM public.telegram_inbox WHERE update_id=987654321),'ambiguous','abandoned handler quarantined');

SELECT ok(public.claim_editorial_run('2099-01-02','00000000-0000-0000-0000-000000000001'), 'editorial claim acquired');
SELECT ok(NOT public.claim_editorial_run('2099-01-02','00000000-0000-0000-0000-000000000002'), 'overlap cannot generate');
SELECT ok(NOT public.finish_editorial_run('2099-01-02','00000000-0000-0000-0000-000000000002','failed'), 'another owner cannot release claim');

SELECT ok(NOT public.reserve_ai_attempt(gen_random_uuid(),'https://fixture.invalid','unknown',10,1,10),'unknown pricing blocks generation');
INSERT INTO public.ai_model_prices VALUES('https://fixture.invalid','fixture',1,2,1000,NOW()+INTERVAL '1 day','https://fixture.invalid/pricing');
SELECT ok(public.reserve_ai_attempt('00000000-0000-0000-0000-000000000003','https://fixture.invalid','fixture',100,1,10),'reviewed model reserves worst case');
SELECT ok(NOT public.reserve_ai_attempt(gen_random_uuid(),'https://fixture.invalid','fixture',100,0.001,10),'reservation enforces daily ceiling');
SELECT ok(public.settle_ai_attempt('00000000-0000-0000-0000-000000000003',NULL,100,10),'usage settles reservation');
SELECT is((SELECT charged_cost FROM public.ai_budget_reservations WHERE id='00000000-0000-0000-0000-000000000003'),0.00012::numeric,'settlement uses reviewed token pricing');
SELECT ok(NOT public.settle_ai_attempt('00000000-0000-0000-0000-000000000003',0,0,0),'settlement cannot be overwritten');
SELECT ok(public.delete_user_data(987654322),'privacy deletion includes operational user data');
SELECT is((SELECT count(*)::int FROM public.telegram_inbox WHERE chat_id=987654322),0,'inbox deleted with user');
SELECT is((SELECT count(*)::int FROM public.email_verification_requests WHERE chat_id=987654322),0,'verification request history deleted with user');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
