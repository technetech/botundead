import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('bot identity survives restarts independently of trading state and rejects corruption', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'undeadbot-identity-'));
  try {
    const store = new Store(directory);
    const id = store.botId();
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(new Store(directory).botId(), id);
    assert.equal(fs.existsSync(store.file), false);
    const state = { version: 1, days: {}, positions: [], paused: 'review' };
    store.save(state);
    assert.equal(new Store(directory).botId(), id);
    assert.deepEqual(store.load(), state);
    fs.writeFileSync(path.join(directory, 'bot-id'), '');
    assert.throws(() => new Store(directory).botId(), /bot-id invalido/);
    assert.deepEqual(store.load(), state);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
