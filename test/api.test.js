import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.js';
import { Bot } from '../src/bot.js';
import { initialState } from '../src/store.js';

test('API 1.4 learns before sending scheduled orders; never requests legacy harness', async () => {
  const paths = [];
  const api = new Api('test-key', async (url, options) => {
    const path = new URL(url).pathname.split('/').at(-1);
    paths.push(path);
    assert.equal(options.headers['X-Api-Key'], 'test-key');
    let data;
    if (path === 'learn') data = { ok: true, learn_version: 'current-version', version: '1.4' };
    else if (path === 'account') data = { ok: true, balance_usdg: 1000, open: [], closed: [] };
    else if (path === 'assets') data = { ok: true, assets: ['BTC', 'ETH', 'SOL'].map(symbol => ({ symbol, price_usd: 100 })) };
    else if (path === 'open') {
      assert.equal(paths[0], 'learn');
      data = { ok: true, position: { id: paths.length, symbol: JSON.parse(options.body).symbol, direction: 'long', status: 'open' } };
    } else assert.fail(`Unexpected route ${path}`);
    return Response.json(data);
  });
  let now = new Date('2026-10-09T14:09:50Z');
  let saved = initialState();
  const bot = new Bot({ api, harness: 'local strategy', mode: 'live', now: () => now,
    store: { load: () => saved, save: state => { saved = structuredClone(state); } } });
  now = new Date('2026-10-09T14:10:00Z');
  await bot.tick();
  assert.equal(saved.paused, null);
  assert.deepEqual(paths, ['learn', 'account', 'assets', 'open', 'open', 'open']);
});

test('learn rejects missing version and surfaces authentication rejection', async () => {
  for (const data of [{ ok: true }, { ok: true, learn_version: '' }, { ok: true, learn_version: 123 }]) {
    await assert.rejects(new Api('test', async () => Response.json(data)).learn(), /falta learn_version/);
  }
  await assert.rejects(new Api('secret', async () => Response.json({ ok: false, reason: 'missing_or_bad_key' }, { status: 401 })).learn(), /HTTP 401, missing_or_bad_key/);
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
