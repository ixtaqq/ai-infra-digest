import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const database = 'supabase_db_ai-infra-digest';
const sql = async statement => {
  const { stdout } = await exec('docker', ['exec', database, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', statement], { timeout: 15000 });
  return stdout.trim();
};
const worker = statement => sql(`SET ROLE service_role; ${statement}`);
const chat = randomBytes(6).readUIntBE(0, 6);
const hash = randomBytes(32).toString('hex');
const owners = [randomUUID(), randomUUID()];
const update = randomBytes(6).readUIntBE(0, 6);
const date = new Date(Date.UTC(2100, 0, 1) + (chat % 36500) * 86400000).toISOString().slice(0, 10);

assert.equal(await sql("SELECT count(*) FROM public.telegram_inbox WHERE status IN ('pending','processing')"), '0', 'Use an idle local inbox for concurrency verification');
assert.equal(await sql(`SELECT count(*) FROM public.user_preferences WHERE chat_id=${chat}`), '0');
assert.equal(await sql(`SELECT count(*) FROM public.editorial_jobs WHERE editorial_date='${date}'`), '0');
assert.equal(await sql(`SELECT count(*) FROM public.telegram_inbox WHERE update_id IN (${update},${update + 1})`), '0');

try {
  const race = async (name, statements) => {
    const results = await Promise.all(statements.map(worker));
    assert.deepEqual(results.sort(), ['f', 't'], `${name} must have exactly one winner`);
    console.log(`${name}: exactly one concurrent claimant`);
  };
  await race('Digest delivery', [0, 1].map(() => `SELECT public.claim_user_delivery(${chat},'${date}')`));
  await race('High-impact alert', [0, 1].map(() => `SELECT public.claim_high_impact_alert(${chat},'${hash}')`));
  await race('Editorial generation', owners.map(owner => `SELECT public.claim_editorial_run('${date}','${owner}')`));

  await worker(`SELECT public.accept_telegram_update(${update},${chat},'{}'); SELECT public.accept_telegram_update(${update + 1},${chat},'{}');`);
  const claims = await Promise.all([worker('SELECT count(*) FROM public.claim_telegram_update()'), worker('SELECT count(*) FROM public.claim_telegram_update()')]);
  assert.deepEqual(claims.sort(), ['0', '1'], 'Only one update from the same chat may process at once');
  const claimed = await sql(`SELECT update_id FROM public.telegram_inbox WHERE chat_id=${chat} AND status='processing'`);
  await worker(`SELECT public.finish_telegram_update(${claimed},'done')`);
  assert.equal(await worker('SELECT count(*) FROM public.claim_telegram_update()'), '1', 'The next update must become eligible after completion');
  console.log('Webhook inbox: concurrent per-chat serialization and subsequent progress passed');
} finally {
  // Remove only the synthetic rows created by this local test, never project data or files.
  await worker(`SELECT public.delete_user_data(${chat})`);
  await sql(`DELETE FROM public.editorial_jobs WHERE editorial_date='${date}' AND owner IN ('${owners[0]}','${owners[1]}')`);
}
