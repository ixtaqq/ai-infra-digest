import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';

// Only the project's local Docker database is used; no .env or remote URL is read.
const database = 'supabase_db_ai-infra-digest';
const container = `goldirham-api-contract-${process.pid}`;
const image = 'postgrest/postgrest:v14.7@sha256:8b53afca2e239bc90a0facdb880710232886c38dae5743a57d66056e96d5596a';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const [db] = JSON.parse(docker(['inspect', database]));
assert.equal(db.State.Running, true, 'Start the local Supabase database first');
const network = Object.keys(db.NetworkSettings.Networks)[0];
assert.equal(network, 'supabase_network_ai-infra-digest');
const password = db.Config.Env.find(value => value.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length);
assert.ok(password, 'Local database password is missing');
const secret = randomBytes(32).toString('hex');
const jwt = role => {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
};
let started = false;
let checks = 0;
try {
  execFileSync('docker', ['run', '-d', '--name', container, '--network', network, '-p', '127.0.0.1::3000',
    '-e', 'PGRST_DB_URI', '-e', 'PGRST_JWT_SECRET', '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', 'PGRST_DB_TX_END=rollback-allow-override', '-e', 'PGRST_DB_MAX_ROWS=1000', image], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      PGRST_DB_URI: `postgresql://postgres:${encodeURIComponent(password)}@${database}:5432/postgres`, PGRST_JWT_SECRET: secret },
  });
  started = true;
  const [rest] = JSON.parse(docker(['inspect', container]));
  const port = rest.NetworkSettings.Ports['3000/tcp'][0].HostPort;
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { ready = (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Startup can take a few seconds. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Local PostgREST did not become ready');
  async function check(path, role = 'anon', options = {}, statuses = [200]) {
    const response = await fetch(base + '/' + path, { ...options, headers: {
      Authorization: `Bearer ${jwt(role)}`, 'Content-Type': 'application/json', ...options.headers,
    }, signal: AbortSignal.timeout(5000) });
    assert.ok(statuses.includes(response.status), `${role} ${path}: HTTP ${response.status}: ${await response.clone().text()}`);
    checks++;
    return response;
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const path of [
      'public_editions?select=*&order=publication_date.desc&limit=1',
      'rpc/latest_feed_health?select=feed_name,status',
      'rpc/stock_mentions_summary?p_since=2026-01-01',
      'articles?select=id,title,url,source,summary,reason,bear_case,created_at&order=effective_score.desc.nullslast,impact_score.desc&limit=1',
      'stock_prices?select=*&order=date.desc,ticker.asc&limit=500&offset=0',
      'sec_filings?select=*&ticker=eq.NVDA&order=filing_date.desc,id.desc&limit=20',
      'ticker_thesis_history?select=*&ticker=eq.NVDA&order=week_of.desc&limit=12',
    ]) await check(path, role);
    for (const table of ['user_preferences','price_watches','telegram_inbox','digest_publications','editorial_jobs','ai_attempts','ai_budget_reservations']) {
      await check(`${table}?select=*&limit=1`, role, {}, role === 'service_role' ? [200] : [401,403]);
    }
    if (role !== 'service_role') {
      await check('rpc/claim_telegram_update', role, { method: 'POST', body: '{}' }, [401,403]);
    }
  }
  // PostgREST rolls every request back, including fixture writes and RPC side effects.
  const fixtureChat = randomBytes(6).readUIntBE(0, 6);
  await check('price_watches', 'service_role', { method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ chat_id: fixtureChat, ticker: 'NVDA', threshold: 130, direction: 'above' }) }, [201]);
  await check('rpc/delete_user_data', 'service_role', { method: 'POST', body: JSON.stringify({ p_chat_id: fixtureChat }) });
  await check('rpc/claim_editorial_run', 'service_role', { method: 'POST', body: JSON.stringify({ p_date: '2099-12-31', p_owner: '00000000-0000-0000-0000-000000000001' }) });
  const result = await check(`price_watches?chat_id=eq.${fixtureChat}`, 'service_role');
  assert.deepEqual(await result.json(), [], 'Fixture writes must roll back');
  console.log(`Local PostgREST contracts passed: ${checks} checks; anonymous, authenticated and service roles; fixture writes rolled back.`);

  // Restart real inbox workers in separate processes; dispatch itself is offline.
  const active = await check('telegram_inbox?status=in.(pending,processing)&select=update_id', 'service_role');
  assert.deepEqual(await active.json(), [], 'Use an idle local inbox for restart verification');
  const updateId = randomBytes(6).readUIntBE(0, 6);
  const committed = body => ({ method: 'POST', headers: { Prefer: 'tx=commit' }, body: JSON.stringify(body) });
  const accept = id => check('rpc/accept_telegram_update', 'service_role', committed({ p_update_id: id, p_chat_id: fixtureChat, p_payload: { update_id: id } }));
  const runWorker = mode => execFileSync(process.execPath, ['-e', `
    require('dotenv').config = () => ({ parsed: {} });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = String(input);
      if (!url.startsWith(process.env.SUPABASE_URL + '/rest/v1/')) throw Error('External network blocked in fixture');
      return realFetch(url.replace('/rest/v1/', '/'), { ...options, headers: { ...options.headers, Prefer: 'tx=commit' } });
    };
    (async () => {
      if (process.env.FIXTURE_MODE === 'crash') {
        await require('./dist/utils/supabase.js').supabase.requiredRpc('claim_telegram_update', {});
        process.exit(0);
      }
      let count = 0;
      await require('./dist/delivery/inbox.js').drainInbox(async () => {
        count++;
        if (process.env.FIXTURE_MODE === 'fail') throw Error('Fixture lost acknowledgement');
      });
      console.log('dispatch-count:' + count);
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, SUPABASE_URL: base,
    SUPABASE_SERVICE_KEY: jwt('service_role'), TELEGRAM_BOT_TOKEN: '123:offline-fixture', TELEGRAM_CHAT_ID: String(fixtureChat),
    AI_API_KEY: 'offline-fixture', AI_PROVIDER: 'groq', FIXTURE_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = async id => (await (await check(`telegram_inbox?update_id=eq.${id}&select=status,payload`, 'service_role')).json())[0];
  try {
    await accept(updateId); await accept(updateId);
    assert.match(runWorker('success'), /dispatch-count:1/);
    assert.match(runWorker('success'), /dispatch-count:0/);
    assert.deepEqual(await state(updateId), { status: 'done', payload: null });
    await accept(updateId + 1);
    assert.match(runWorker('fail'), /dispatch-count:1/);
    assert.match(runWorker('success'), /dispatch-count:0/);
    assert.deepEqual(await state(updateId + 1), { status: 'ambiguous', payload: null });
    await accept(updateId + 2); runWorker('crash');
    docker(['exec', database, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c',
      `UPDATE public.telegram_inbox SET started_at=NOW()-INTERVAL '11 minutes' WHERE update_id=${updateId + 2} AND chat_id=${fixtureChat}`]);
    assert.match(runWorker('success'), /dispatch-count:0/);
    assert.deepEqual(await state(updateId + 2), { status: 'ambiguous', payload: null });
    console.log('Inbox restart checks passed: durable acceptance, deduplication, completed payload erasure, failed-dispatch quarantine, and abandoned-claim quarantine.');
  } finally {
    await check('rpc/delete_user_data', 'service_role', committed({ p_chat_id: fixtureChat }));
  }
} finally {
  if (started) docker(['stop', container]);
}
