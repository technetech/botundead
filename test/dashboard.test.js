import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, Monitor, snapshot } from '../src/dashboard.js';

const password = 'test-password-for-local-tests';
const headers = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` };

test('dashboard protects account and static assets, permits health, exposes no mutation routes', async () => {
  const server = await createDashboard({ getSnapshot: () => ({ balance: 1000 }), password, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: 'Basic malformed' } })).status, 401);
    const response = await fetch(`${base}/api/status`, { headers });
    assert.deepEqual(await response.json(), { balance: 1000 });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/api/open`, { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(`${base}/.env`, { headers })).status, 404);
    const page = await fetch(base, { headers });
    assert.match(await page.text(), /Tu estrategia/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(`${base}/app.js`, { headers })).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('missing dashboard password never exposes private data', async () => {
  const server = await createDashboard({ getSnapshot: () => { throw new Error('Must not read private state'); }, port: 0, host: '127.0.0.1' });
  try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).status, 503); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('monitor caches reads and stops automatic retries after failure', async () => {
  let now = new Date('2026-10-08T16:00:00Z'); let calls = 0;
  const monitor = new Monitor({ learn: async () => ({ learn_version: 'test-v1' }), account: async () => { calls++; return { balance_usdg: 100, open: [], closed: [] }; } }, 'rules', () => now);
  monitor.refresh(); await monitor.pending;
  monitor.refresh(); assert.equal(calls, 1); assert.equal(monitor.apiReady, true); assert.equal(monitor.learnVersion, 'test-v1');
  now = new Date('2026-10-08T16:01:00Z'); monitor.api.account = async () => { calls++; throw new Error('offline'); };
  monitor.refresh(); await monitor.pending;
  now = new Date('2026-10-08T16:02:00Z'); monitor.refresh();
  assert.equal(calls, 2); assert.equal(monitor.error, 'offline'); assert.equal(monitor.apiReady, false); assert.equal(monitor.account.balance_usdg, 100);
});

test('snapshot selects known IDs and never serializes secrets or raw account data', () => {
  const bot = { mode: 'live', harness: 'rules', started: new Date('2026-10-08T16:00:00Z'), state: { paused: null, days: {}, positions: [{ id: 1, symbol: 'BTC', day: '2026-10-08', status: 'open', margin: 25, leverage: 10, closeSeconds: 42600 }] } };
  const monitor = { account: { balance_usdg: 900, equity_usdg: 1000, secret: 'never-expose', open: [{ id: 1, price_usd: 70000, live_pnl: 5, note: 'private' }, { id: 2, symbol: 'MANUAL' }], closed: [] }, harnessMatches: true, updatedAt: '2026-10-08T16:00:00Z', error: null };
  const result = snapshot(bot, monitor, [], new Date('2026-10-08T16:20:00Z'));
  assert.equal(result.positions.length, 1); assert.equal(result.positions[0].pnl, 5);
  assert.equal(result.positions[0].closeAt, '2026-10-08 11:50');
  assert.equal(result.nextOpening, '2026-10-08T18:10:00.000Z');
  assert.equal(JSON.stringify(result).includes('never-expose'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
