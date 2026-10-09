import { ApiError } from './api.js';
import { STRATEGY, localTime, cycleAt, clock } from './schedule.js';
export { STRATEGY, localTime } from './schedule.js';

export function normalizeHarness(text) { return text.replace(/\r\n/g, '\n').trim(); }
export function validateAccount(account) {
  if (!Number.isFinite(account.balance_usdg) || !Array.isArray(account.open) || !Array.isArray(account.closed)
      || account.open.some(p => !Number.isSafeInteger(p.id) || p.id <= 0)) {
    throw new Error('Contrato /account inesperado; no se enviaron nuevas ordenes');
  }
  return account;
}

export class Bot {
  constructor({ api, store, harness, mode = 'dry-run', now = () => new Date(), log = () => {} }) {
    this.api = api;
    this.store = store;
    this.harness = normalizeHarness(harness);
    this.mode = mode;
    this.now = now;
    this.log = log;
    this.state = store.load();
    this.started = now();
    this.previewed = new Set();
  }

  save() { this.store.save(this.state); }
  pause(message) {
    this.state.paused = message;
    this.save();
    this.log('paused', { reason: message });
  }

  async check() {
    const learned = await this.api.learn();
    const account = validateAccount(await this.api.account());
    const assets = await this.api.assets();
    if (!Array.isArray(assets.assets)) throw new Error('Contrato /assets inesperado');
    return {
      apiReady: true,
      learnVersion: learned.learn_version,
      balance: account.balance_usdg,
      openPositions: account.open.length,
      symbolsAvailable: STRATEGY.symbols.every(s => assets.assets.some(a => a.symbol === s)),
    };
  }

  async tick() {
    if (this.state.paused) return;
    try { await this.runTick(); }
    catch (error) { this.pause(error.message); }
  }

  async runTick() {
    const current = localTime(this.now());
    const pending = Object.values(this.state.days).some(d => Object.values(d).some(v => v.status === 'pending'));
    if (pending) throw new Error('Apertura incierta pendiente de conciliacion manual; no se repetira');
    const due = this.state.positions.filter(p => p.status !== 'closed' && (p.day < current.day || (p.day === current.day && current.seconds >= (p.closeSeconds ?? 64500))));
    if (due.length) {
      await this.api.learn(); // La API marca la key con la version vigente antes de operar.
      const account = validateAccount(await this.api.account());
      for (const p of due) {
        if (!account.open.some(a => a.id === p.id)) {
          p.status = 'closed';
          const closed = account.closed.find(a => a.id === p.id);
          if (Number.isFinite(closed?.pnl)) p.pnl = closed.pnl;
          p.closedAt = this.now().toISOString();
          this.save();
          this.log('already_closed', { id: p.id });
          continue;
        }
        if (p.status === 'closing') throw new Error(`Cierre incierto de ${p.id}; revisar manualmente`);
        if (this.mode === 'dry-run') {
          this.preview(`close-${p.id}`, { action: 'close', id: p.id });
          continue;
        }
        p.status = 'closing';
        this.save();
        try {
          const result = await this.api.close({ id: p.id, note: `undeadbot: cierre programado ${clock(p.closeSeconds ?? 64500)} America/Monterrey; entrada ${p.cycle ?? p.day} ${p.symbol}` });
          if (Number.isFinite(result.pnl)) p.pnl = result.pnl;
        } catch (error) {
          if (error instanceof ApiError && !error.uncertain) { p.status = 'open'; this.save(); }
          throw error;
        }
        p.status = 'closed';
        p.closedAt = this.now().toISOString();
        this.save();
        this.log('closed', { id: p.id, symbol: p.symbol });
      }
    }
    // Una clave por ciclo, conservando los registros diarios de la version anterior.
    const cycle = cycleAt(this.now());
    const started = localTime(this.started);
    if (current.seconds < cycle.open || current.seconds >= cycle.open + 60
        || (started.day === current.day && started.seconds >= cycle.open)
        || this.state.days[cycle.key] || this.state.positions.some(p => p.status !== 'closed')) return;
    if (this.mode === 'dry-run' && this.previewed.has(cycle.key)) return;
    await this.api.learn();
    const account = validateAccount(await this.api.account());
    if (account.balance_usdg < 75) throw new Error('Saldo insuficiente: se necesitan 75 USDG libres');
    const assets = await this.api.assets();
    if (!Array.isArray(assets.assets) || STRATEGY.symbols.some(s => !assets.assets.some(a => a.symbol === s && Number.isFinite(a.price_usd) && a.price_usd > 0))) {
      throw new Error('Falta un activo o un precio valido en /assets');
    }
    if (this.mode === 'dry-run') {
      this.preview(cycle.key, { action: 'open', symbols: STRATEGY.symbols, margin: 25, leverage: 10 });
      return;
    }
    this.state.days[cycle.key] = {};
    this.save();
    for (const symbol of STRATEGY.symbols) {
      const time = localTime(this.now());
      if (time.day !== current.day || time.seconds < cycle.open || time.seconds >= cycle.open + 60) {
        this.log('entry_window_missed', { symbol });
        break;
      }
      const record = { status: 'pending' };
      this.state.days[cycle.key][symbol] = record;
      this.save(); // Persistir la intencion ANTES de enviar la orden.
      let result;
      try {
        result = await this.api.open({ symbol, direction: 'long', size_usd: 25, leverage: 10,
          note: `undeadbot:${cycle.key}:${symbol}:long; margen 25 USDG; 10x; cierre ${clock(cycle.close)} America/Monterrey` });
      } catch (error) {
        if (error instanceof ApiError && !error.uncertain) { record.status = 'rejected'; this.save(); }
        throw error;
      }
      const p = result.position;
      if (!p || !Number.isSafeInteger(p.id) || p.id <= 0 || p.symbol !== symbol || p.direction !== 'long' || p.status !== 'open'
          || this.state.positions.some(old => old.id === p.id)) {
        throw new Error('Respuesta de apertura inesperada; revisar la cuenta sin repetir la orden');
      }
      record.status = 'opened';
      record.id = p.id;
      this.state.positions.push({ id: p.id, symbol, day: current.day, cycle: cycle.key, closeSeconds: cycle.close,
        margin: 25, leverage: 10, openedAt: this.now().toISOString(), status: 'open' });
      this.save();
      this.log('opened', { id: p.id, symbol });
    }
  }

  preview(key, detail) {
    if (this.previewed.has(key)) return;
    this.previewed.add(key);
    this.log('dry_run', detail);
  }
}
