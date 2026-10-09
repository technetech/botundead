import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot, localTime } from '../src/bot.js';
import { Api, ApiError } from '../src/api.js';
import { Store, initialState } from '../src/store.js';
import { nextOpening } from '../src/schedule.js';

function fixture(options = {}) {
  let time = new Date('2026-10-08T16:09:50Z');
  let saved = initialState();
  const orders = [];
  const closes = [];
  const positions = [{ id: 90, symbol: 'BTC', direction: 'long', status: 'open' }];
  let id = 100;
  const api = {
    learn: async () => ({ learn_version: 'test-v1' }),
    account: async () => ({ balance_usdg: 1000, open: positions, closed: [] }),
    assets: async () => ({ assets: ['BTC', 'ETH', 'SOL'].map(symbol => ({ symbol, price_usd: 100 })) }),
    open: async body => {
      orders.push(body);
      const position = { id: ++id, symbol: body.symbol, direction: 'long', status: 'open' };
      positions.push(position);
      return { position };
    },
    close: async body => { closes.push(body); positions.splice(positions.findIndex(p => p.id === body.id), 1); return { ok: true }; },
  };
  const store = { load: () => structuredClone(saved), save: state => { saved = structuredClone(state); } };
  const makeBot = () => new Bot({ api, store, harness: 'rules', mode: 'live', now: () => time, ...options });
  return { api, store, orders, closes, positions, makeBot, bot: makeBot(), setTime: value => { time = new Date(value); } };
}

test('Monterrey schedule uses the explicit zone, not the host timezone', () => {
  assert.deepEqual(localTime(new Date('2026-10-08T16:10:00Z')), { day: '2026-10-08', seconds: 36600 });
});

test('opens exactly three 25 USDG longs at 10x, survives restart, closes only owned IDs', async () => {
  const f = fixture();
  f.setTime('2026-10-08T16:10:00Z');
  await f.bot.tick();
  await f.bot.tick();
  await f.makeBot().tick();
  assert.equal(f.orders.length, 3);
  for (const o of f.orders) {
    assert.equal(o.direction, 'long'); assert.equal(o.size_usd, 25); assert.equal(o.leverage, 10);
    assert.ok(o.note.length <= 500);
  }
  f.setTime('2026-10-08T17:50:00Z');
  await f.makeBot().tick();
  assert.deepEqual(f.closes.map(p => p.id), [101, 102, 103]);
  assert.equal(f.positions[0].id, 90);
});

test('late startup skips entry; old positions close on reconnection', async () => {
  const f = fixture();
  f.setTime('2026-10-08T16:10:00Z');
  await f.makeBot().tick();
  assert.equal(f.orders.length, 0);
  await f.bot.tick();
  f.setTime('2026-10-09T12:00:00Z');
  await f.makeBot().tick();
  assert.equal(f.closes.length, 3);
});

test('dry-run never mutates the API and previews once', async () => {
  const events = [];
  const f = fixture({ mode: 'dry-run', log: event => events.push(event) });
  f.setTime('2026-10-08T16:10:00Z');
  await f.bot.tick(); await f.bot.tick();
  assert.equal(f.orders.length, 0);
  assert.deepEqual(events, ['dry_run']);
});

test('insufficient balance and failed API learning stop before any order', async () => {
  for (const change of [
    f => { f.api.account = async () => ({ balance_usdg: 74, open: [], closed: [] }); },
    f => { f.api.learn = async () => { throw new ApiError('/learn: HTTP 401, missing_or_bad_key'); }; },
  ]) {
    const f = fixture(); change(f);
    f.setTime('2026-10-08T16:10:00Z');
    await f.bot.tick();
    assert.equal(f.orders.length, 0);
    assert.ok(f.store.load().paused);
  }
});

test('uncertain opening is persisted before transmission and never repeated after restart', async () => {
  const f = fixture(); let calls = 0;
  f.api.open = async () => {
    calls++;
    assert.equal(f.store.load().days['2026-10-08T10:10'].BTC.status, 'pending');
    throw new ApiError('timeout', true);
  };
  f.setTime('2026-10-08T16:10:00Z');
  await f.bot.tick();
  const persisted = f.store.load(); persisted.paused = null; f.store.save(persisted);
  await f.makeBot().tick();
  assert.equal(calls, 1);
  assert.match(f.store.load().paused, /incierta/);
});

test('definitive rejection is not retried and a malformed success remains uncertain', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(); let calls = 0;
    f.api.open = async () => { calls++; if (uncertain) return {}; throw new ApiError('bad_params', false); };
    f.setTime('2026-10-08T16:10:00Z');
    await f.bot.tick(); await f.bot.tick();
    assert.equal(calls, 1);
    assert.equal(f.store.load().days['2026-10-08T10:10'].BTC.status, uncertain ? 'pending' : 'rejected');
  }
});

test('entry window expires during requests: remaining symbols are skipped', async () => {
  const f = fixture(); const open = f.api.open;
  f.api.open = async body => { const result = await open(body); f.setTime('2026-10-08T16:11:00Z'); return result; };
  f.setTime('2026-10-08T16:10:00Z');
  await f.bot.tick();
  assert.equal(f.orders.length, 1);
});

test('uncertain close is never repeated blindly', async () => {
  const f = fixture();
  f.setTime('2026-10-08T16:10:00Z'); await f.bot.tick();
  let calls = 0;
  f.api.close = async () => { calls++; throw new ApiError('timeout', true); };
  f.setTime('2026-10-08T17:50:00Z'); await f.bot.tick();
  const state = f.store.load(); state.paused = null; f.store.save(state);
  await f.makeBot().tick();
  assert.equal(calls, 1);
});

test('manually closed positions are reconciled without another close', async () => {
  const f = fixture();
  f.setTime('2026-10-08T16:10:00Z'); await f.bot.tick();
  f.positions.splice(1, 1);
  f.setTime('2026-10-08T17:50:00Z'); await f.bot.tick();
  assert.deepEqual(f.closes.map(p => p.id), [102, 103]);
});

test('API sends documented headers and bodies; network errors never retry', async () => {
  let calls = 0;
  const api = new Api('test-key', async (url, options) => {
    calls++;
    assert.equal(options.headers['X-Api-Key'], 'test-key');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).symbol, 'BTC');
    throw new Error('network');
  });
  await assert.rejects(api.open({ symbol: 'BTC' }), error => error.uncertain === true);
  assert.equal(calls, 1);
});

test('API handles rejection, invalid JSON and server failure conservatively', async () => {
  for (const [status, data, uncertain] of [[429, { ok: false, reason: 'rate_limited' }, false], [500, { ok: false }, true], [200, { ok: false, reason: 'bad_params' }, false]]) {
    const api = new Api('secret', async () => new Response(JSON.stringify(data), { status }));
    await assert.rejects(api.open({}), error => error.uncertain === uncertain);
  }
  const api = new Api('secret', async () => new Response('<html>error</html>'));
  await assert.rejects(api.open({}), error => error.uncertain);
});

test('disk state survives reload; lock excludes another process; corrupt state fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undeadbot-test-'));
  try {
    const store = new Store(dir);
    const state = initialState(); state.paused = 'review'; store.save(state);
    assert.equal(new Store(dir).load().paused, 'review');
    const unlock = store.lock();
    assert.throws(() => new Store(dir).lock(), /process.lock/);
    unlock();
    fs.writeFileSync(path.join(dir, 'state.json'), 'broken');
    assert.throws(() => store.load());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cycles repeat at 10:10 and 12:10 with 100-minute closes and no restart duplicates', async () => {
  const f = fixture();
  f.setTime('2026-10-08T16:10:00Z'); await f.bot.tick();
  f.setTime('2026-10-08T17:49:59Z'); await f.bot.tick(); assert.equal(f.closes.length, 0);
  f.setTime('2026-10-08T17:50:00Z'); await f.bot.tick(); assert.equal(f.closes.length, 3);
  f.setTime('2026-10-08T18:09:50Z'); const restarted = f.makeBot();
  f.setTime('2026-10-08T18:10:00Z'); await restarted.tick(); await restarted.tick();
  assert.equal(f.orders.length, 6);
  assert.ok(f.store.load().days['2026-10-08T12:10']);
  f.setTime('2026-10-08T19:50:00Z'); await restarted.tick(); assert.equal(f.closes.length, 6);
});

test('24-hour schedule crosses midnight and executes overnight', async () => {
  const f = fixture();
  f.setTime('2026-10-09T04:10:00Z'); await f.bot.tick();
  assert.ok(f.store.load().days['2026-10-08T22:10']);
  f.setTime('2026-10-09T05:50:00Z'); await f.bot.tick();
  f.setTime('2026-10-09T06:10:00Z'); await f.bot.tick();
  assert.ok(f.store.load().days['2026-10-09T00:10']);
  f.setTime('2026-10-09T07:50:00Z'); await f.bot.tick();
  assert.equal(f.orders.length, 6); assert.equal(f.closes.length, 6);
  assert.equal(nextOpening(new Date('2026-10-09T05:51:00Z')), '2026-10-09T06:10:00.000Z');
});

test('legacy state preserves IDs and closes at 17:55, not on the new schedule', async () => {
  const f = fixture();
  const state = f.store.load();
  state.days['2026-10-08'] = { BTC: { status: 'opened', id: 90 } };
  state.positions.push({ id: 90, symbol: 'BTC', day: '2026-10-08', status: 'open' });
  f.store.save(state); const migrated = f.makeBot();
  f.setTime('2026-10-08T16:10:00Z'); await migrated.tick(); assert.equal(f.orders.length, 0);
  f.setTime('2026-10-08T23:50:00Z'); await migrated.tick(); assert.equal(f.closes.length, 0);
  f.setTime('2026-10-08T23:55:00Z'); await migrated.tick(); assert.equal(f.closes[0].id, 90);
  assert.ok(f.store.load().days['2026-10-08']);
});

test('PnL returned by close is persisted for the dashboard after a restart', async () => {
  const f = fixture(); const close = f.api.close;
  f.api.close = async body => { await close(body); return { ok: true, pnl: 2.5 }; };
  f.setTime('2026-10-08T16:10:00Z'); await f.bot.tick();
  f.setTime('2026-10-08T17:50:00Z'); await f.bot.tick();
  assert.equal(f.makeBot().state.positions[0].pnl, 2.5);
});
