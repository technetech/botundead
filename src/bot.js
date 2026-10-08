import { ApiError } from './api.js';

export const STRATEGY = Object.freeze({ symbols: ['BTC', 'ETH', 'SOL'], margin: 100, leverage: 3, timezone: 'America/Monterrey' });
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: STRATEGY.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function localTime(date) {
  const p = Object.fromEntries(formatter.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}
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
    const harness = await this.api.harness();
    const account = validateAccount(await this.api.account());
    const assets = await this.api.assets();
    if (!Array.isArray(assets.assets)) throw new Error('Contrato /assets inesperado');
    return {
      harnessMatches: typeof harness.content === 'string' && normalizeHarness(harness.content) === this.harness,
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
    const due = this.state.positions.filter(p => p.status !== 'closed' && (p.day < current.day || current.seconds >= 64500));
    if (due.length) {
      await this.api.harness(); // La API requiere leer las reglas antes de operar.
      const account = validateAccount(await this.api.account());
      for (const p of due) {
        if (!account.open.some(a => a.id === p.id)) {
          p.status = 'closed';
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
          await this.api.close({ id: p.id, note: `undeadbot: cierre programado 17:55 America/Monterrey; entrada ${p.day} ${p.symbol}` });
        } catch (error) {
          if (error instanceof ApiError && !error.uncertain) { p.status = 'open'; this.save(); }
          throw error;
        }
        p.status = 'closed';
        this.save();
        this.log('closed', { id: p.id, symbol: p.symbol });
      }
    }
    // 08:50:00 a 08:50:59; un arranque tardio nunca recupera entradas.
    const started = localTime(this.started);
    if (current.seconds < 31800 || current.seconds >= 31860
        || (started.day === current.day && started.seconds >= 31800)
        || this.state.days[current.day] || this.state.positions.some(p => p.status !== 'closed')) return;
    if (this.mode === 'dry-run' && this.previewed.has(current.day)) return;
    const harness = await this.api.harness();
    if (typeof harness.content !== 'string' || normalizeHarness(harness.content) !== this.harness) {
      throw new Error('Harness distinto: copiar harness.md en el panel Agent antes de habilitar entradas');
    }
    const account = validateAccount(await this.api.account());
    if (account.balance_usdg < 300) throw new Error('Saldo insuficiente: se necesitan 300 USDG libres');
    const assets = await this.api.assets();
    if (!Array.isArray(assets.assets) || STRATEGY.symbols.some(s => !assets.assets.some(a => a.symbol === s && Number.isFinite(a.price_usd) && a.price_usd > 0))) {
      throw new Error('Falta un activo o un precio valido en /assets');
    }
    if (this.mode === 'dry-run') {
      this.preview(current.day, { action: 'open', symbols: STRATEGY.symbols, margin: 100, leverage: 3 });
      return;
    }
    this.state.days[current.day] = {};
    this.save();
    for (const symbol of STRATEGY.symbols) {
      const time = localTime(this.now());
      if (time.day !== current.day || time.seconds >= 31860) {
        this.log('entry_window_missed', { symbol });
        break;
      }
      const record = { status: 'pending' };
      this.state.days[current.day][symbol] = record;
      this.save(); // Persistir la intencion ANTES de enviar la orden.
      let result;
      try {
        result = await this.api.open({ symbol, direction: 'long', size_usd: 100, leverage: 3,
          note: `undeadbot:${current.day}:${symbol}:long; entrada diaria 08:50 America/Monterrey; margen 100 USDG; 3x; cierre 17:55` });
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
      this.state.positions.push({ id: p.id, symbol, day: current.day, status: 'open' });
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
