import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const image = process.argv[2] || 'goldirham-webhook:local';
assert.match(image, /^goldirham-webhook:[a-z0-9-]+$/);
const container = `goldirham-webhook-smoke-${process.pid}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
docker(['run', '-d', '--name', container, '--network', 'none',
  '-e', 'TELEGRAM_BOT_TOKEN=123:offline-fixture', '-e', 'TELEGRAM_CHAT_ID=1',
  '-e', 'AI_API_KEY=offline-fixture', '-e', 'WEBHOOK_SECRET=offline-fixture-secret', image]);
try {
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      docker(['exec', container, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]);
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(ready, 'Webhook did not become healthy');
  const result = docker(['exec', container, 'node', '-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    (async () => {
      assert.notEqual(process.getuid(),0);
      for(const path of ['/app/.cache','/app/.ai-cache','/app/logs']) fs.accessSync(path,fs.constants.W_OK);
      assert.equal(fs.existsSync('/app/.env'),false);
      for(const [payload,secret,status] of [
        [{update_id:1},'wrong-secret',403],
        [{message:{}},'offline-fixture-secret',400],
        [{update_id:1},'offline-fixture-secret',503],
      ]) {
        const response = await fetch('http://127.0.0.1:3000/telegram/webhook', {
          method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000),
        });
        assert.equal(response.status,status);
      }
      console.log('Container verified: health, non-root, writable directories, no .env, auth/shape rejection, and HTTP 503 when durable acceptance fails. Network disabled.');
    })().catch(error=>{console.error(error.message);process.exitCode=1;});
  `]);
  process.stdout.write(result);
} finally {
  docker(['stop', container]);
}
