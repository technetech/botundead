import { Api, Heartbeat, VersionMonitor } from './api.js';
import { Bot } from './bot.js';
import { PromptBot } from './prompt-bot.js';
import { Monitor, snapshot } from './dashboard.js';
import { newAgent } from './workspace.js';
import { connectionsFor, publicConnection, configureConnections, connectionKey } from './connections.js';

export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const engineFor = agent => agent.engine === 'agent' || agent.engine === 'prompt' ? 'agent' : 'bot';
export function executionReadiness(agent, workspace) {
  const missing = [];
  if (!workspace.source(agent)) missing.push('Conecta la API de Undeadwallet');
  if (engineFor(agent) === 'agent') {
    const connections = connectionsFor(agent, workspace);
    const ai = connections.find(c => c.kind === 'ai');
    if (!ai) missing.push('Añade un proveedor de IA');
    else {
      if (!ai.model) missing.push('Indica el modelo de IA');
      if (!connectionKey(ai, workspace)) missing.push('Configura la clave del proveedor de IA');
    }
    for (const c of connections.filter(c => c.kind === 'data')) {
      if (c.auth !== 'none' && !connectionKey(c, workspace)) missing.push(`Configura la credencial de ${c.name}`);
    }
  }
  return { ready: missing.length === 0, missing };
}
export function hasPending(agent) {
  return agent.state.positions.some(p => p.status !== 'closed') || Object.values(agent.state.days).some(d => Object.values(d).some(p => p.status === 'pending'));
}
function capitalValue(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw new InputError('El capital inicial debe ser mayor que 0 y hasta 1.000.000 USDG, con dos decimales como máximo');
  return value;
}
export function configure(agent, input) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new InputError('Nombre obligatorio, máximo 80 caracteres');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw new InputError('Instrucción obligatoria, máximo 20 000 caracteres');
  if (input.autoStart !== undefined && typeof input.autoStart !== 'boolean') throw new InputError('Guardado automático inválido');
  if (input.autoStart !== true && (!['dry-run', 'live'].includes(input.mode) || typeof input.enabled !== 'boolean')) throw new InputError('Modo o activación inválidos');
  const engine = input.engine ?? engineFor(agent);
  if (!['bot', 'agent'].includes(engine)) throw new InputError('Selecciona un único modo: Agente o Bot');
  if (hasPending(agent)) throw new InputError('Hay posiciones u órdenes pendientes: conserva la configuración hasta conciliarlas', 409);
  let strategy = agent.strategy;
  if (engine === 'bot') {
    if (input.symbols !== undefined && !Array.isArray(input.symbols)) throw new InputError('La lista de activos debe ser un arreglo');
    const entries = input.entries ?? (input.symbols ? input.symbols.map(symbol => ({ symbol, margin: input.margin, leverage: input.leverage, direction: input.direction })) : strategy.entries || strategy.symbols.map(symbol => ({ symbol, margin: strategy.margin, leverage: strategy.leverage, direction: strategy.direction || 'long' })));
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10 || entries.some(p => !p || typeof p.symbol !== 'string' || !/^[A-Z0-9][A-Z0-9._/-]{0,31}$/.test(p.symbol)) || new Set(entries.map(p => p.symbol)).size !== entries.length) throw new InputError('Indica entre 1 y 10 activos únicos de Undeadwallet');
    if (entries.some(p => !Number.isFinite(p.margin) || p.margin <= 0 || p.margin > 1000000 || !Number.isInteger(p.leverage) || p.leverage < 1 || p.leverage > 100 || !['long','short'].includes(p.direction))) throw new InputError('Margen, apalancamiento o dirección inválidos');
    if (entries.reduce((sum,p) => sum + p.margin,0) > (agent.initialCapital ?? 1000000)) throw new InputError('El margen total supera el capital inicial del espacio');
    strategy = { ...strategy, symbols: entries.map(p => p.symbol), margin: entries[0].margin, leverage: entries[0].leverage, direction: entries[0].direction, entries: entries.map(({symbol,margin,leverage,direction}) => ({symbol,margin,leverage,direction})) };
  }
  return { ...agent, name: input.name.trim(), prompt: input.prompt.trim(), enabled: input.autoStart === true ? false : input.enabled, mode: input.autoStart === true ? 'live' : input.mode, engine, strategy,
    startedAt: new Date().toISOString(), monitor: null, nextBeat: 0, nextVersion: 0, updatedAt: new Date().toISOString() };
}

export class Agents {
  constructor(workspace, apiFactory = key => new Api(key), now = () => new Date(), read) { this.workspace = workspace; this.apiFactory = apiFactory; this.now = now; this.read = read; this.assetCache = new Map(); }
  view(agent) {
    const bot = { state: agent.state, mode: agent.mode, strategy: agent.strategy, harness: agent.prompt, started: new Date(agent.startedAt) };
    const monitor = agent.monitor || { account: null, updatedAt: null, error: null, apiReady: null };
    return { id: agent.id, slot: agent.slot, name: agent.name, prompt: agent.prompt, enabled: agent.enabled, engine: engineFor(agent),
      initialCapital: agent.initialCapital ?? null, canDelete: !hasPending(agent), execution: executionReadiness(agent, this.workspace),
      connections: connectionsFor(agent, this.workspace).map(c => publicConnection(c, this.workspace)),
      connection: { provider: 'Undeadwallet', source: this.workspace.source(agent), configured: Boolean(this.workspace.source(agent)) },
      createdAt: agent.createdAt, ...snapshot(bot, monitor, agent.events, this.now()) };
  }
  list() { return this.workspace.run(data => ({ agents: data.agents.map(a => this.view(a)), limit: 10, storage: this.workspace.kind, execution: this.workspace.env.VERCEL ? 'cron' : 'worker' })); }
  async create(input) {
    const initialCapital = capitalValue(input.initialCapital ?? 1000);
    return this.workspace.run(data => {
      if (data.agents.length >= 10) throw new InputError('Ya tienes los 10 espacios ocupados', 409);
      const slot = Array.from({ length: 10 }, (_, i) => i + 1).find(n => !data.agents.some(a => a.slot === n));
      const agent = newAgent(slot, { name: typeof input.name === 'string' ? input.name.trim().slice(0, 80) : undefined, initialCapital });
      data.agents.push(agent); return this.view(agent);
    });
  }
  remove(id) {
    return this.workspace.run(data => {
      const index = data.agents.findIndex(a => a.id === id);
      if (index < 0) throw new InputError('Espacio no encontrado', 404);
      const agent = data.agents[index];
      if (hasPending(agent)) throw new InputError('Primero cierra o concilia las posiciones pendientes de este espacio para no dejarlas sin gestionar', 409);
      // Keep the audit trail out of the active spaces, including when the last card is removed.
      data.archivedAgents ||= []; data.archivedAgents.push({ ...agent, enabled: false, deletedAt: this.now().toISOString() });
      data.agents.splice(index,1); this.assetCache.delete(id); return { ok: true };
    });
  }
  async assets(id) {
    const credentials = await this.workspace.run(data => {
      const agent = data.agents.find(a => a.id === id); if (!agent) throw new InputError('Espacio no encontrado',404);
      const key = this.workspace.key(agent); if (!key) throw new InputError('Conecta y guarda primero la API de Undeadwallet para cargar sus activos',409);
      return { key, botId: agent.botId };
    });
    const cached = this.assetCache.get(id);
    if (cached && cached.key === credentials.key && cached.expires > this.now().getTime()) return cached.result;
    const api = this.apiFactory(credentials.key); api.botId = credentials.botId;
    let response; try { response = await api.assets(); } catch(error) { throw new InputError(error.message,502); }
    if (!Array.isArray(response.assets)) throw new InputError('Undeadwallet no devolvió un catálogo válido',502);
    const assets = response.assets.filter(a => typeof a.symbol === 'string').map(a => ({ symbol: a.symbol, name: typeof a.name === 'string' ? a.name : a.symbol, kind: typeof a.kind === 'string' ? a.kind : 'other', price: Number.isFinite(a.price_usd) ? a.price_usd : null }));
    const result = { assets, updatedAt: this.now().toISOString() };
    this.assetCache.set(id, { key: credentials.key, expires: this.now().getTime()+60000, result }); return result;
  }
  update(id, input) {
    return this.workspace.run(data => {
      const index = data.agents.findIndex(a => a.id === id);
      if (index < 0) throw new InputError('Agente no encontrado', 404);
      const agent = configure(data.agents[index], input);
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw new InputError('Clave API inválida');
      if (input.apiKey?.trim() && input.removeKey === true) throw new InputError('Elige guardar una clave o quitarla');
      if (input.apiKey?.trim()) {
        try { agent.secret = this.workspace.encrypt(input.apiKey.trim()); }
        catch { throw new InputError('No se pudo cifrar la API key. Configura CREDENTIALS_KEY con 64 caracteres hexadecimales y revisa el almacenamiento.'); }
      }
      if (input.removeKey === true) delete agent.secret;
      if (input.connections !== undefined) {
        try { agent.connections = configureConnections(input.connections, data.agents[index], this.workspace); }
        catch(error) { throw new InputError(error.message); }
        agent.connectionsConfigured = true;
      }
      const key = this.workspace.key(agent);
      if (input.autoStart === true) agent.enabled = executionReadiness(agent, this.workspace).ready;
      if (agent.enabled && !key) throw new InputError('Conecta una API de Undeadwallet antes de activar el agente');
      if (agent.enabled && engineFor(agent) === 'agent') {
        const ai = connectionsFor(agent,this.workspace).find(c => c.kind === 'ai');
        if (!ai?.model || !connectionKey(ai,this.workspace)) throw new InputError('Añade una API de IA y su modelo para activar el modo Agente');
      }
      if (key && data.agents.some(a => a.id !== id && this.workspace.key(a) === key)) throw new InputError('Esta API key ya pertenece a otro agente. Usa una clave independiente por agente', 409);
      delete agent.state.nextDecisionAt;
      agent.events.push({ at: this.now().toISOString(), event: 'configuration_updated' });
      data.agents[index] = agent; this.assetCache.delete(id); return this.view(agent);
    });
  }
  async tick() {
    return this.workspace.run(async (data, save) => {
      const keys = data.agents.map(a => this.workspace.key(a));
      await Promise.all(data.agents.map(async (agent, index) => {
        const key = keys[index]; if (!key) return;
        let secrets = [key];
        const log = (event, detail = {}) => {
          const safe = JSON.parse(JSON.stringify(detail, (_k,v) => typeof v === 'string' ? secrets.reduce((s,key) => s.replaceAll(key,'[REDACTED]'),v) : v));
          agent.events.push({ at: this.now().toISOString(), event, ...safe });
        };
        if (keys.indexOf(key) !== index) { agent.state.paused = 'API key duplicada entre agentes; asigna claves independientes'; await save(); return; }
        try {
          secrets = [key, ...connectionsFor(agent,this.workspace).map(c => connectionKey(c,this.workspace))].filter(Boolean);
          const api = this.apiFactory(key); api.botId = agent.botId;
          const Engine = engineFor(agent) === 'agent' ? PromptBot : Bot;
          const bot = new Engine({ api, store: { load: () => agent.state, save: async state => { agent.state = state; await save(); } },
            harness: agent.prompt, strategy: agent.strategy, mode: agent.mode, initialCapital: agent.initialCapital ?? Infinity, log, now: this.now, agent, workspace: this.workspace, read: this.read });
          bot.started = new Date(agent.startedAt); bot.previewed = new Set(agent.previewed || []);
          if (agent.enabled) await bot.tick();
          agent.previewed = [...bot.previewed].slice(-100);
          const monitor = new Monitor(api, agent.prompt, this.now); Object.assign(monitor, agent.monitor || {});
          monitor.refresh(); if (monitor.pending) await monitor.pending;
          agent.monitor = Object.fromEntries(['account','updatedAt','error','apiReady','learnVersion','nextRead'].map(k => [k, monitor[k]]));
          if (agent.enabled) {
            const beat = new Heartbeat(api, log, () => this.now().getTime()); beat.nextBeat = agent.nextBeat || 0;
            await beat.tick(); agent.nextBeat = beat.nextBeat;
            const version = new VersionMonitor(api, log, () => this.now().getTime()); version.nextRead = agent.nextVersion || 0; version.learnVersion = agent.learnVersion;
            version.refresh(); if (version.pending) await version.pending;
            agent.nextVersion = version.nextRead; agent.learnVersion = version.learnVersion;
          }
        } catch { log('agent_error', { reason: 'No se pudo procesar el agente. Revisa la conexión y la configuración del servidor.' }); }
        await save();
      }));
      return { ok: true, agents: data.agents.length };
    });
  }
}
