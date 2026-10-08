import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api } from './api.js';
import { Bot, STRATEGY } from './bot.js';
import { Store } from './store.js';
import { Monitor, createDashboard, snapshot } from './dashboard.js';

const events = [];
const log = (event, detail = {}) => {
  const entry = { at: new Date().toISOString(), event, ...detail };
  events.push(entry);
  if (events.length > 100) events.shift();
  console.log(JSON.stringify(entry));
};
let unlock;
let server;
let monitor;
let stopping = false;
try {
  const mode = process.env.BOT_MODE || 'dry-run';
  if (!['dry-run', 'live'].includes(mode)) throw new Error('BOT_MODE debe ser dry-run o live');
  const store = new Store(process.env.DATA_DIR || './data');
  const command = process.argv[2] || 'start';
  if (!['start', 'check', 'status', 'resume'].includes(command)) throw new Error('Comando desconocido');
  if (command === 'status') {
    console.log(JSON.stringify(store.load(), null, 2));
  } else if (command === 'resume') {
    unlock = store.lock();
    const state = store.load();
    if (Object.values(state.days).some(day => Object.values(day).some(p => p.status === 'pending')) || state.positions.some(p => p.status === 'closing')) {
      throw new Error('Resolver las ordenes inciertas en state.json antes de reanudar. Ver README.');
    }
    state.paused = null;
    store.save(state);
    log('resumed');
  } else {
    const key = process.env.UNDEAD_API_KEY?.trim();
    if (!key) throw new Error('Falta UNDEAD_API_KEY. Configurar .env o las variables de Railway');
    const harness = fs.readFileSync(fileURLToPath(new URL('../harness.md', import.meta.url)), 'utf8');
    const bot = new Bot({ api: new Api(key), store, harness, mode, log });
    if (command === 'check') {
      const result = await bot.check();
      log('connection_check', result);
      if (!result.harnessMatches || !result.symbolsAvailable || result.balance < 75) process.exitCode = 1;
    } else {
      unlock = store.lock();
      // Cargar de nuevo bajo el lock para excluir cambios de otra instancia.
      bot.state = store.load();
      store.save(bot.state);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
      monitor = new Monitor(bot.api, harness);
      server = await createDashboard({ getSnapshot: () => snapshot(bot, monitor, events),
        password: process.env.DASHBOARD_PASSWORD, port: Number(process.env.PORT || 3000) });
      log('dashboard_started', { port: server.address().port, protected: Boolean(process.env.DASHBOARD_PASSWORD?.length >= 12) });
      log('started', { mode, strategy: STRATEGY, paused: bot.state.paused });
      let heartbeat = 0;
      while (!stopping) {
        await bot.tick();
        monitor.refresh();
        if (Date.now() >= heartbeat) {
          log('heartbeat', { mode, paused: bot.state.paused, trackedOpen: bot.state.positions.filter(p => p.status !== 'closed').length });
          heartbeat = Date.now() + 300000;
        }
        if (!stopping) await sleep(5000);
      }
      log('stopped');
    }
  }
} catch (error) {
  log('fatal', { reason: error.message });
  process.exitCode = 1;
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (monitor?.pending) await monitor.pending;
  if (unlock) unlock();
}
