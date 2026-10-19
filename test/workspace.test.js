import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { Agents } from '../src/agents.js';
import { Store } from '../src/store.js';
import { createDashboard, dashboardHandler } from '../src/dashboard.js';

const password = 'local-test-dashboard-password';
const headers = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`, 'Content-Type': 'application/json' };
function input(agent, extra = {}) { return { name: agent.name, prompt: agent.prompt, symbols: agent.strategy.symbols, margin: agent.strategy.margin, leverage: agent.strategy.leverage, direction: agent.strategy.direction, mode: agent.mode, enabled: agent.enabled, ...extra }; }
async function fixture(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undeadbot-workspace-'));
  const workspace = await new Workspace({ DATA_DIR: dir, ...env }).init();
  return { dir, workspace, agents: new Agents(workspace), close: async () => { await workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('fresh installation starts without API keys and allocates exactly ten isolated spaces under concurrent creation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.agents.list()).agents.length, 1);
    const created = await Promise.all(Array.from({ length: 9 }, (_, i) => f.agents.create({ name: `Agent ${i}` })));
    assert.equal(new Set(created.map(a => a.id)).size, 9);
    await assert.rejects(f.agents.create({}), /10 espacios/);
    const list = await f.agents.list(); assert.equal(list.agents.length, 10);
    assert.deepEqual(list.agents.map(a => a.slot), [1,2,3,4,5,6,7,8,9,10]);
    assert.ok(list.agents.every(a => !a.enabled && a.mode === 'dry-run' && a.positions.length === 0));
  } finally { await f.close(); }
});

test('legacy migration preserves identity, pauses, uncertain orders and historical IDs exactly once', async () => {
  const f = await fixture({ UNDEAD_API_KEY: 'legacy-key', BOT_MODE: 'live' });
  try {
    fs.unlinkSync(f.workspace.file);
    const legacy = new Store(f.dir); const id = legacy.botId();
    const state = { version: 1, days: { '2026-10-08': { BTC: { status: 'pending' } } }, paused: 'review', positions: [{ id: 7, symbol: 'BTC', day: '2026-10-08', status: 'open' }] };
    legacy.save(state);
    await f.workspace.run(data => { assert.equal(data.agents[0].botId, id); assert.deepEqual(data.agents[0].state, state); });
    legacy.save({ version: 1, days: {}, positions: [], paused: null });
    await f.workspace.run(data => assert.deepEqual(data.agents[0].state, state));
  } finally { await f.close(); }
});

test('credentials are encrypted at rest, never returned, persist after restart and obey environment priority', async () => {
  const f = await fixture();
  try {
    const first = (await f.agents.list()).agents[0];
    const updated = await f.agents.update(first.id, input(first, { apiKey: 'top-secret-value', prompt: '<script>not executed</script>' }));
    assert.equal(updated.connection.source, 'panel');
    assert.ok(!JSON.stringify(updated).includes('top-secret-value'));
    assert.ok(!fs.readFileSync(f.workspace.file, 'utf8').includes('top-secret-value'));
    const restarted = await new Workspace({ DATA_DIR: f.dir, AGENT_1_UNDEAD_API_KEY: 'env-key' }).init();
    await restarted.run(data => assert.equal(restarted.key(data.agents[0]), 'env-key'));
    delete restarted.env.AGENT_1_UNDEAD_API_KEY;
    await restarted.run(data => assert.equal(restarted.key(data.agents[0]), 'top-secret-value'));
    assert.equal((await new Agents(restarted).list()).agents[0].prompt, '<script>not executed</script>');
    await restarted.close();
  } finally { await f.close(); }
});

test('activation needs a key, duplicate keys fail, and pending positions or intentions block edits', async () => {
  const f = await fixture();
  try {
    const a = (await f.agents.list()).agents[0]; const b = await f.agents.create({});
    await assert.rejects(f.agents.update(a.id, input(a, { enabled: true })), /Conecta/);
    await f.agents.update(a.id, input(a, { apiKey: 'same-key' }));
    await assert.rejects(f.agents.update(b.id, input(b, { apiKey: 'same-key' })), /otro agente/);
    await f.workspace.run(data => { data.agents[0].state.positions.push({ id: 5, day: '2026-10-08', symbol: 'BTC', status: 'open' }); });
    await assert.rejects(f.agents.update(a.id, input(a)), /pendientes/);
    await f.workspace.run(data => { data.agents[0].state.positions = []; data.agents[0].state.days.x = { BTC: { status: 'pending' } }; });
    await assert.rejects(f.agents.update(a.id, input(a)), /pendientes/);
    await assert.rejects(f.agents.update(b.id, input(b, { margin: -1 })), /Margen/);
  } finally { await f.close(); }
});

test('different agents execute their configured strategy and persist intentions before asynchronous orders and restart', async () => {
  const f = await fixture();
  try {
    const a = (await f.agents.list()).agents[0]; const b = await f.agents.create({ name: 'Short ETH' });
    await f.agents.update(a.id, input(a, { apiKey: 'key-a', enabled: true, mode: 'live', symbols: ['BTC'], margin: 12, leverage: 2 }));
    await f.agents.update(b.id, input(b, { apiKey: 'key-b', enabled: true, mode: 'live', symbols: ['ETH'], margin: 8, leverage: 3, direction: 'short' }));
    await f.workspace.run(data => { for (const agent of data.agents) agent.startedAt = '2026-10-08T16:24:00Z'; });
    let id = 100; const orders = [];
    const agents = new Agents(f.workspace, key => ({
      learn: async () => ({ learn_version: 'test' }),
      account: async () => ({ balance_usdg: 100, open: [], closed: [] }),
      assets: async () => ({ assets: ['BTC', 'ETH'].map(symbol => ({ symbol, price_usd: 100 })) }),
      open: async body => {
        const disk = JSON.parse(fs.readFileSync(f.workspace.file, 'utf8'));
        const own = disk.agents.find(a => f.workspace.key(a) === key);
        assert.equal(own.state.days['2026-10-08T10:25'][body.symbol].status, 'pending');
        orders.push({ key, ...body }); return { position: { id: ++id, ...body, status: 'open' } };
      }, heartbeat: async () => ({}), version: async () => ({ version: '1', learn_version: '1', must_relearn: false }),
    }), () => new Date('2026-10-08T16:25:00Z'));
    await agents.tick(); await agents.tick(); assert.equal(orders.length, 2);
    const short = orders.find(o => o.key === 'key-b'); assert.equal(short.direction, 'short'); assert.equal(short.size_usd, 8); assert.equal(short.leverage, 3);
    const restart = await new Workspace({ DATA_DIR: f.dir }).init();
    const list = await new Agents(restart).list();
    assert.deepEqual(list.agents.map(a => a.positions.map(p => p.symbol)), [['BTC'], ['ETH']]);
    assert.ok(list.agents.every(a => a.events.some(e => e.event === 'opened')));
    await restart.close();
  } finally { await f.close(); }
});

test('historical activity and positions are preserved beyond the old sixty entry limit', async () => {
  const f = await fixture();
  try {
    await f.workspace.run(data => {
      data.agents[0].events = Array.from({ length: 120 }, (_, i) => ({ at: new Date().toISOString(), event: 'closed', id: i + 1 }));
      data.agents[0].state.positions = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, day: '2026-10-08', symbol: 'BTC', status: 'closed', pnl: i }));
    });
    const first = (await f.agents.list()).agents[0]; assert.equal(first.events.length, 120); assert.equal(first.positions.length, 120); assert.equal(first.events[0].id, 120);
  } finally { await f.close(); }
});

test('HTTP agent routes protect secrets, reject CSRF and enforce authenticated creation and updates', async () => {
  const f = await fixture();
  const server = await createDashboard({ agents: f.agents, password, cronSecret: 'cron-secret', port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/agents`)).status, 401);
    assert.equal((await fetch(`${base}/api/cron`)).status, 401);
    assert.equal((await fetch(`${base}/api/agents`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/agents`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/api/agents`, { method: 'POST', headers, body: '{' })).status, 400);
    const response = await fetch(`${base}/api/agents`, { method: 'POST', headers, body: '{"name":"New agent"}' }); assert.equal(response.status, 201);
    const agent = await response.json();
    const update = await fetch(`${base}/api/agents/${agent.id}`, { method: 'PUT', headers, body: JSON.stringify(input(agent, { apiKey: 'server-secret' })) });
    assert.equal(update.status, 200); assert.ok(!(await update.text()).includes('server-secret'));
    f.agents.tick = async () => ({ ok: true });
    assert.equal((await fetch(`${base}/api/cron`, { headers: { Authorization: 'Bearer cron-secret' } })).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('Vercel rejects ephemeral storage instead of silently losing history', () => {
  assert.throws(() => new Workspace({ VERCEL: '1' }), /DATABASE_URL/);
});

test('moving a local workspace to PostgreSQL preserves agents and encrypted credentials instead of stale legacy state', async () => {
  const f = await fixture({ CREDENTIALS_KEY: 'b'.repeat(64) });
  try {
    const first = (await f.agents.list()).agents[0];
    await f.agents.update(first.id, input(first, { apiKey: 'migration-secret' }));
    await f.agents.create({ name: 'Second strategy' });
    new Store(f.dir).save({ version: 1, days: {}, positions: [], paused: 'stale legacy state' });
    const target = new Workspace({ DATABASE_URL: 'postgres://unused', DATA_DIR: f.dir, CREDENTIALS_KEY: 'b'.repeat(64) });
    const imported = target.seed();
    assert.equal(imported.agents.length, 2); assert.equal(imported.agents[0].id, first.id);
    assert.equal(imported.agents[0].state.paused, null); assert.equal(target.key(imported.agents[0]), 'migration-secret');
    const wrongKey = new Workspace({ DATABASE_URL: 'postgres://unused', DATA_DIR: f.dir, CREDENTIALS_KEY: 'c'.repeat(64) });
    assert.throws(() => wrongKey.seed());
  } finally { await f.close(); }
});

test('Vercel JSON body helpers are accepted even when the request stream was already consumed', async () => {
  let received;
  const handler = dashboardHandler({ password, agents: { create: async input => { received = input; return { id: 'test' }; } } });
  const req = { url: '/api/agents', method: 'POST', headers: { authorization: headers.Authorization, 'content-type': 'application/json' }, body: { name: 'Vercel agent' } };
  let code, body;
  const res = { setHeader() {}, writeHead(value) { code = value; }, end(value) { body = value; } };
  await handler(req, res);
  assert.equal(code, 201); assert.deepEqual(received, { name: 'Vercel agent' }); assert.equal(JSON.parse(body).id, 'test');
});

test('PostgreSQL initializes and coordinates concurrent installations without lost updates', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const env = { DATABASE_URL: process.env.TEST_DATABASE_URL, CREDENTIALS_KEY: 'a'.repeat(64) };
  const [a, b] = await Promise.all([new Workspace(env).init(), new Workspace(env).init()]);
  try {
    // TEST_DATABASE_URL must point to a disposable test database.
    await a.run(data => { data.agents = [data.agents[0]]; });
    const aa = new Agents(a); const bb = new Agents(b);
    await Promise.all(Array.from({ length: 9 }, (_, i) => (i % 2 ? aa : bb).create({ name: `Concurrent ${i}` })));
    assert.equal((await aa.list()).agents.length, 10);
    const agent = (await aa.list()).agents[0]; await aa.update(agent.id, input(agent, { apiKey: 'postgres-secret' }));
    await b.run(data => assert.equal(b.key(data.agents[0]), 'postgres-secret'));
  } finally { await a.close(); await b.close(); }
});
