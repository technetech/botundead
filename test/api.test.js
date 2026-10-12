import test from 'node:test';
import assert from 'node:assert/strict';
import { Api, Heartbeat, VersionMonitor } from '../src/api.js';
import { Bot } from '../src/bot.js';
import { initialState } from '../src/store.js';

test('API 1.13 learns before sending scheduled orders; never requests legacy harness', async () => {
  const paths = [];
  const api = new Api('test-key', async (url, options) => {
    const path = new URL(url).pathname.split('/').at(-1);
    paths.push(path);
    assert.equal(options.headers['X-Asset-Key'], 'test-key');
    let data;
    if (path === 'learn') data = { ok: true, learn_version: 'current-version', version: '1.13' };
    else if (path === 'account') data = { ok: true, balance_usdg: 1000, open: [], closed: [] };
    else if (path === 'assets') data = { ok: true, assets: ['BTC', 'ETH', 'SOL'].map(symbol => ({ symbol, price_usd: 100 })) };
    else if (path === 'open') {
      assert.equal(paths[0], 'learn');
      data = { ok: true, position: { id: paths.length, symbol: JSON.parse(options.body).symbol, direction: 'long', status: 'open' } };
    } else assert.fail(`Unexpected route ${path}`);
    return Response.json(data);
  });
  let now = new Date('2026-10-09T14:24:50Z');
  let saved = initialState();
  const bot = new Bot({ api, harness: 'local strategy', mode: 'live', now: () => now,
    store: { load: () => saved, save: state => { saved = structuredClone(state); } } });
  now = new Date('2026-10-09T14:25:00Z');
  await bot.tick();
  assert.equal(saved.paused, null);
  assert.deepEqual(paths, ['learn', 'account', 'assets', 'open', 'open', 'open']);
});

test('API heartbeat is POST without body and does not require learn', async () => {
  const api = new Api('test-key', async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/trading/agent/heartbeat');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Asset-Key'], 'test-key');
    assert.equal(options.body, undefined);
    assert.equal(options.headers['Content-Type'], undefined);
    return Response.json({ ok: true, live: true, every_s: 60, live_window_s: 180 });
  });
  assert.equal((await api.heartbeat()).live, true);
});

test('heartbeat sends immediately and every 60 seconds, recovering after failure', async () => {
  let now = 1000;
  let calls = 0;
  const events = [];
  const heartbeat = new Heartbeat({ heartbeat: async () => {
    calls++;
    if (calls === 2) throw new Error('offline');
    return { ok: true, live: true };
  } }, (event, detail) => events.push({ event, ...detail }), () => now);
  await heartbeat.tick();
  now += 59999;
  await heartbeat.tick();
  assert.equal(calls, 1);
  now++;
  await heartbeat.tick();
  assert.equal(events[1].event, 'api_heartbeat_error');
  await heartbeat.tick();
  assert.equal(calls, 2);
  now += 60000;
  await heartbeat.tick();
  assert.equal(calls, 3);
  assert.equal(events[2].event, 'api_heartbeat');
});

test('learn rejects missing version and surfaces authentication rejection', async () => {
  for (const data of [{ ok: true }, { ok: true, learn_version: '' }, { ok: true, learn_version: 123 }]) {
    await assert.rejects(new Api('test', async () => Response.json(data)).learn(), /falta learn_version/);
  }
  await assert.rejects(new Api('secret', async () => Response.json({ ok: false, reason: 'missing_or_bad_key' }, { status: 401 })).learn(), /HTTP 401, missing_or_bad_key/);
});

test('version monitor polls every 15 minutes and relearns only when required', async () => {
  let now = 1000;
  let reads = 0;
  let learns = 0;
  let required = false;
  const monitor = new VersionMonitor({
    version: async () => { reads++; return { version: '1.13', learn_version: 'v13', must_relearn: required }; },
    learn: async () => { learns++; return { learn_version: 'v13' }; },
  }, () => {}, () => now);
  monitor.refresh(); await monitor.pending;
  monitor.refresh();
  assert.equal(reads, 1);
  assert.equal(learns, 0);
  now += 15 * 60000;
  required = true;
  monitor.refresh(); await monitor.pending;
  assert.equal(reads, 2);
  assert.equal(learns, 1);
});

test('version monitor prevents overlapping requests and recovers after errors', async () => {
  let now = 1000;
  let rejectRead;
  const events = [];
  let reads = 0;
  const monitor = new VersionMonitor({ version: () => {
    reads++;
    return new Promise((resolve, reject) => { rejectRead = reject; });
  } }, event => events.push(event), () => now);
  monitor.refresh();
  now += 15 * 60000;
  monitor.refresh();
  assert.equal(reads, 1);
  rejectRead(new Error('offline'));
  await monitor.pending;
  assert.deepEqual(events, ['api_version_error']);
  monitor.api.version = async () => { reads++; return { version: '1.13', learn_version: 'v13', must_relearn: false }; };
  monitor.refresh(); await monitor.pending;
  assert.equal(reads, 2);
});

test('version endpoint validates the provider contract with the new authentication header', async () => {
  const api = new Api('test-key', async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/trading/agent/version');
    assert.equal(options.headers['X-Asset-Key'], 'test-key');
    assert.equal(options.headers['X-Api-Key'], undefined);
    return Response.json({ ok: true, version: '1.13', learn_version: 'v13', must_relearn: false });
  });
  assert.equal((await api.version()).must_relearn, false);
  await assert.rejects(new Api('test', async () => Response.json({ ok: true, version: '1.13', learn_version: 'v13' })).version(), /contrato inesperado/);
});

test('HTML errors retain HTTP status and uncertain POSTs stay uncertain', async () => {
  const api = new Api('secret', async () => new Response('<html>secret</html>', { status: 404 }));
  await assert.rejects(api.learn(), error => /HTTP 404, respuesta no JSON/.test(error.message) && !error.uncertain && !error.message.includes('secret'));
  await assert.rejects(api.open({}), error => error.uncertain);
});

test('timeouts and connection failures have separate diagnostic messages without secrets', async () => {
  for (const [error, expected] of [
    [new DOMException('secret', 'TimeoutError'), /timeout de 15 segundos/],
    [new TypeError('secret', { cause: { code: 'ENOTFOUND' } }), /fallo de conexion \(ENOTFOUND\)/],
  ]) {
    const api = new Api('secret', async () => { throw error; });
    await assert.rejects(api.learn(), result => expected.test(result.message) && !result.message.includes('secret'));
  }
});
