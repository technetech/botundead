import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Store, initialState } from './store.js';
import { STRATEGY } from './schedule.js';

export const defaultHarness = fs.readFileSync(new URL('../harness.md', import.meta.url), 'utf8');
export function newAgent(slot, input = {}) {
  const initialCapital = input.initialCapital ?? 1000;
  const symbols = initialCapital < 0.03 ? ['BTC'] : [...STRATEGY.symbols];
  const margin = Math.min(STRATEGY.margin, Math.floor(initialCapital * 100 / symbols.length) / 100);
  return { id: randomUUID(), slot, name: input.name || `Agente ${slot}`, prompt: input.prompt || defaultHarness,
    strategy: { ...STRATEGY, symbols, margin, direction: 'long' }, engine: 'bot', initialCapital, connections: [], mode: 'dry-run', enabled: false,
    botId: randomUUID(), state: initialState(), events: [], createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), monitor: null };
}

// One workspace per installation; credentials never appear in public projections.
export class Workspace {
  constructor(env = process.env) {
    this.env = env;
    this.directory = env.DATA_DIR || './data';
    this.file = path.join(this.directory, 'workspace.json');
    this.queue = Promise.resolve();
    this.kind = env.DATABASE_URL ? 'postgres' : 'file';
    if (env.VERCEL && this.kind !== 'postgres') throw new Error('Vercel requiere DATABASE_URL: el disco temporal no conserva el historial');
  }

  async init() {
    if (this.kind === 'postgres') {
      const { Pool } = await import('pg');
      this.pool = new Pool({ connectionString: this.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000 });
      const client = await this.pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(19780521)');
        await client.query('CREATE TABLE IF NOT EXISTS undeadbot_workspace (id integer PRIMARY KEY CHECK (id = 1), document jsonb NOT NULL)');
      } finally {
        try { await client.query('SELECT pg_advisory_unlock(19780521)'); client.release(); }
        catch { client.release(true); }
      }
    } else fs.mkdirSync(this.directory, { recursive: true });
    await this.run(async () => {});
    return this;
  }

  seed() {
    // Moving a current local installation to an empty database must not reimport
    // the stale legacy state.json or start with a different trading identity.
    if (this.kind === 'postgres' && fs.existsSync(this.file)) {
      const imported = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (imported.version !== 1 || !Array.isArray(imported.agents)) throw new Error('Workspace local inválido para importar');
      for (const agent of imported.agents) {
        if (agent.secret) this.decrypt(agent.secret);
        for (const connection of agent.connections || []) if (connection.secret) this.decrypt(connection.secret);
      }
      return imported;
    }
    const agent = newAgent(1);
    // Import only into an empty installation, preserving identity, IDs and pauses.
    if (fs.existsSync(path.join(this.directory, 'state.json'))) {
      const legacy = new Store(this.directory);
      agent.state = legacy.load(); agent.botId = legacy.botId();
      agent.mode = this.env.BOT_MODE || 'dry-run'; agent.enabled = Boolean(this.env.UNDEAD_API_KEY);
      agent.engine = 'legacy';
      delete agent.initialCapital;
      agent.name = 'Agente principal';
    }
    return { version: 1, agents: [agent] };
  }

  async run(fn) {
    const previous = this.queue;
    let release; this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    let client, existing = false;
    try {
      if (this.pool) {
        client = await this.pool.connect();
        // Session lock, with autocommit: intentions survive a killed function/failed order.
        await client.query('SELECT pg_advisory_lock(19780521)');
        const result = await client.query('SELECT document FROM undeadbot_workspace WHERE id = 1');
        existing = result.rows.length > 0;
        this.data = result.rows[0]?.document || this.seed();
      } else {
        existing = fs.existsSync(this.file);
        this.data = existing ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : this.seed();
      }
      if (this.data.version !== 1 || !Array.isArray(this.data.agents) || this.data.agents.length > 10) throw new Error('Workspace invalido; revisar respaldo');
      let saved = existing ? JSON.stringify(this.data) : null;
      const save = async () => {
        const serialized = JSON.stringify(this.data);
        if (serialized === saved) return;
        if (client) await client.query('INSERT INTO undeadbot_workspace (id, document) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document', [serialized]);
        else {
          const fd = fs.openSync(`${this.file}.tmp`, 'w', 0o600);
          try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(`${this.file}.tmp`, this.file);
        }
        saved = serialized;
      };
      await save();
      const result = await fn(this.data, save);
      await save();
      return result;
    } finally {
      if (client) {
        try { await client.query('SELECT pg_advisory_unlock(19780521)'); client.release(); }
        catch { client.release(true); }
      }
      release();
    }
  }

  encryptionKey() {
    let key = this.env.CREDENTIALS_KEY;
    if (!key && this.kind === 'file') {
      const file = path.join(this.directory, 'credentials.key');
      if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
      key = fs.readFileSync(file, 'utf8').trim();
    }
    if (!/^[a-fA-F0-9]{64}$/.test(key || '')) throw new Error('Configura CREDENTIALS_KEY con 64 caracteres hexadecimales para guardar claves desde el panel');
    return Buffer.from(key, 'hex');
  }
  encrypt(value) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
  }
  decrypt(secret) {
    const [iv, tag, value] = secret.split(':');
    const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(iv, 'hex'));
    cipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([cipher.update(Buffer.from(value, 'hex')), cipher.final()]).toString('utf8');
  }
  key(agent) {
    const envKey = this.env[`AGENT_${agent.slot}_UNDEAD_API_KEY`] || (agent.slot === 1 ? this.env.UNDEAD_API_KEY : '');
    if (envKey?.trim()) return envKey.trim();
    if (!agent.secret) return '';
    return this.decrypt(agent.secret);
  }
  source(agent) {
    return (this.env[`AGENT_${agent.slot}_UNDEAD_API_KEY`] || (agent.slot === 1 && this.env.UNDEAD_API_KEY)) ? 'environment' : agent.secret ? 'panel' : null;
  }
  async close() { await this.pool?.end(); }
}
