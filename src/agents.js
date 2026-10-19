import { Api, Heartbeat, VersionMonitor } from './api.js';
import { Bot } from './bot.js';
import { Monitor, snapshot } from './dashboard.js';
import { newAgent } from './workspace.js';

export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export function configure(agent, input) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new InputError('Nombre obligatorio, máximo 80 caracteres');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw new InputError('Estrategia obligatoria, máximo 20 000 caracteres');
  if (!['dry-run', 'live'].includes(input.mode) || typeof input.enabled !== 'boolean') throw new InputError('Modo o activación inválidos');
  const symbols = input.symbols;
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 10 || symbols.some(s => typeof s !== 'string' || !/^[A-Z0-9]{2,15}$/.test(s)) || new Set(symbols).size !== symbols.length) throw new InputError('Indica entre 1 y 10 símbolos únicos');
  if (!Number.isFinite(input.margin) || input.margin <= 0 || input.margin > 1000000 || !Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 100 || !['long', 'short'].includes(input.direction)) throw new InputError('Margen, apalancamiento o dirección inválidos');
  if (agent.state.positions.some(p => p.status !== 'closed') || Object.values(agent.state.days).some(d => Object.values(d).some(p => p.status === 'pending'))) throw new InputError('Hay posiciones u órdenes pendientes: conserva la configuración hasta conciliarlas', 409);
  return { ...agent, name: input.name.trim(), prompt: input.prompt.trim(), enabled: input.enabled, mode: input.mode,
    strategy: { ...agent.strategy, symbols, margin: input.margin, leverage: input.leverage, direction: input.direction },
    startedAt: new Date().toISOString(), monitor: null, nextBeat: 0, nextVersion: 0, updatedAt: new Date().toISOString() };
}

export class Agents {
  constructor(workspace, apiFactory = key => new Api(key), now = () => new Date()) { this.workspace = workspace; this.apiFactory = apiFactory; this.now = now; }
  view(agent) {
    const bot = { state: agent.state, mode: agent.mode, strategy: agent.strategy, harness: agent.prompt, started: new Date(agent.startedAt) };
    const monitor = agent.monitor || { account: null, updatedAt: null, error: null, apiReady: null };
    return { id: agent.id, slot: agent.slot, name: agent.name, prompt: agent.prompt, enabled: agent.enabled,
      connection: { provider: 'Undeadwallet', source: this.workspace.source(agent), configured: Boolean(this.workspace.source(agent)) },
      createdAt: agent.createdAt, ...snapshot(bot, monitor, agent.events, this.now()) };
  }
  list() { return this.workspace.run(data => ({ agents: data.agents.map(a => this.view(a)), limit: 10, storage: this.workspace.kind, execution: this.workspace.env.VERCEL ? 'cron' : 'worker' })); }
  create(input) {
    return this.workspace.run(data => {
      if (data.agents.length >= 10) throw new InputError('Ya tienes los 10 espacios ocupados', 409);
      const slot = Array.from({ length: 10 }, (_, i) => i + 1).find(n => !data.agents.some(a => a.slot === n));
      const agent = newAgent(slot, { name: typeof input.name === 'string' ? input.name.trim().slice(0, 80) : undefined });
      data.agents.push(agent); return this.view(agent);
    });
  }
  update(id, input) {
    return this.workspace.run(data => {
      const index = data.agents.findIndex(a => a.id === id);
      if (index < 0) throw new InputError('Agente no encontrado', 404);
      const agent = configure(data.agents[index], input);
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096)) throw new InputError('Clave API inválida');
      if (input.apiKey?.trim() && input.removeKey === true) throw new InputError('Elige guardar una clave o quitarla');
      if (input.apiKey?.trim()) {
        try { agent.secret = this.workspace.encrypt(input.apiKey.trim()); }
        catch { throw new InputError('No se pudo cifrar la API key. Configura CREDENTIALS_KEY con 64 caracteres hexadecimales y revisa el almacenamiento.'); }
      }
      if (input.removeKey === true) delete agent.secret;
      const key = this.workspace.key(agent);
      if (agent.enabled && !key) throw new InputError('Conecta una API antes de activar el agente');
      if (key && data.agents.some(a => a.id !== id && this.workspace.key(a) === key)) throw new InputError('Esta API key ya pertenece a otro agente. Usa una clave independiente por agente', 409);
      agent.events.push({ at: this.now().toISOString(), event: 'configuration_updated' });
      data.agents[index] = agent; return this.view(agent);
    });
  }
  async tick() {
    // Independent agents run concurrently; all saves are serialized on the same locked connection.
    return this.workspace.run(async (data, save) => {
      const keys = data.agents.map(a => this.workspace.key(a));
      await Promise.all(data.agents.map(async (agent, index) => {
        const key = keys[index]; if (!key) return;
        const log = (event, detail = {}) => {
          // API errors are already redacted, also scrub provider echoes defensively.
          const safe = JSON.parse(JSON.stringify(detail).replaceAll(key, '[REDACTED]'));
          agent.events.push({ at: this.now().toISOString(), event, ...safe });
        };
        if (keys.indexOf(key) !== index) { agent.state.paused = 'API key duplicada entre agentes; asigna claves independientes'; await save(); return; }
        try {
          const api = this.apiFactory(key); api.botId = agent.botId;
          const bot = new Bot({ api, store: { load: () => agent.state, save: async state => { agent.state = state; await save(); } },
            harness: agent.prompt, strategy: agent.strategy, mode: agent.mode, log, now: this.now });
          bot.started = new Date(agent.startedAt);
          bot.previewed = new Set(agent.previewed || []);
          if (agent.enabled) await bot.tick();
          agent.previewed = [...bot.previewed].slice(-100);
          const monitor = new Monitor(api, agent.prompt, this.now);
          Object.assign(monitor, agent.monitor || {});
          monitor.refresh(); if (monitor.pending) await monitor.pending;
          agent.monitor = Object.fromEntries(['account', 'updatedAt', 'error', 'apiReady', 'learnVersion', 'nextRead'].map(k => [k, monitor[k]]));
          if (agent.enabled) {
            const beat = new Heartbeat(api, log, () => this.now().getTime()); beat.nextBeat = agent.nextBeat || 0;
            await beat.tick(); agent.nextBeat = beat.nextBeat;
            const version = new VersionMonitor(api, log, () => this.now().getTime()); version.nextRead = agent.nextVersion || 0; version.learnVersion = agent.learnVersion;
            version.refresh(); if (version.pending) await version.pending;
            agent.nextVersion = version.nextRead; agent.learnVersion = version.learnVersion;
          }
        } catch { log('agent_error', { reason: 'No se pudo procesar el agente. Revisa la conexión y la configuración del servidor.' }); }
        // Persist all events, including through restarts; no session-only history.
        await save();
      }));
      return { ok: true, agents: data.agents.length };
    });
  }
}
