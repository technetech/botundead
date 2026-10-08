import http from 'node:http';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { STRATEGY, localTime, nextOpening, clock, cycleAt } from './schedule.js';
import { normalizeHarness, validateAccount } from './bot.js';

export class Monitor {
  constructor(api, harness, now = () => new Date()) {
    this.api = api; this.harness = harness; this.now = now;
    this.account = null; this.updatedAt = null; this.error = null; this.harnessMatches = null;
    this.nextRead = 0; this.pending = null;
  }
  refresh() {
    if (this.pending || this.error || this.now().getTime() < this.nextRead) return;
    this.nextRead = this.now().getTime() + 60000;
    this.pending = (async () => {
      try {
        const rules = await this.api.harness();
        this.harnessMatches = typeof rules.content === 'string' && normalizeHarness(rules.content) === normalizeHarness(this.harness);
        this.account = validateAccount(await this.api.account());
        this.updatedAt = this.now().toISOString();
      } catch (error) { this.error = error.message; }
      finally { this.pending = null; }
    })();
  }
}

export function snapshot(bot, monitor, events, now = new Date()) {
  const account = monitor.account;
  const current = localTime(now);
  const positions = bot.state.positions.map(p => {
    const live = account?.open.find(a => a.id === p.id);
    const closed = account?.closed.find(a => a.id === p.id);
    return { id: p.id, symbol: p.symbol, status: p.status, day: p.day, cycle: p.cycle ?? 'Estrategia diaria anterior',
      margin: p.margin ?? 100, leverage: p.leverage ?? 3,
      closeAt: `${p.day} ${clock(p.closeSeconds ?? 64500)}`,
      price: Number.isFinite(live?.price_usd) ? live.price_usd : null,
      pnl: Number.isFinite(live?.live_pnl) ? live.live_pnl : (p.pnl ?? (Number.isFinite(closed?.pnl) ? closed.pnl : null)),
      accountStatus: live ? 'open' : closed ? 'closed' : 'unknown' };
  });
  const tracked = positions.filter(p => p.status !== 'closed');
  const cycle = cycleAt(now);
  const started = localTime(bot.started);
  const entering = current.seconds >= cycle.open && current.seconds < cycle.open + 60
    && (started.day < current.day || started.seconds < cycle.open) && !bot.state.days[cycle.key];
  return { now: now.toISOString(), mode: bot.mode, paused: bot.state.paused, strategy: STRATEGY,
    local: current, nextOpening: nextOpening(now), entering, nextOpeningBlocked: Boolean(bot.state.paused || tracked.length || monitor.harnessMatches !== true),
    balance: account?.balance_usdg ?? null, equity: Number.isFinite(account?.equity_usdg) ? account.equity_usdg : null,
    accountUpdatedAt: monitor.updatedAt, accountError: monitor.error, harnessMatches: monitor.harnessMatches,
    harness: bot.harness, positions: [...tracked, ...positions.filter(p => p.status === 'closed').slice(-60).reverse()],
    trackedOpen: tracked.length, accountOpen: account?.open.length ?? null, events: events.slice(-60).reverse() };
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
export function createDashboard({ getSnapshot, password, host = '0.0.0.0', port = 3000 }) {
  const expected = createHash('sha256').update(`admin:${password || ''}`).digest();
  let failures = 0; let resetAt = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
    if (!password || password.length < 12) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Panel pendiente: configura DASHBOARD_PASSWORD con al menos 12 caracteres en Railway. Usuario: admin.'); return;
    }
    const authorization = req.headers.authorization || '';
    const credentials = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString('utf8') : '';
    const valid = timingSafeEqual(expected, createHash('sha256').update(credentials).digest());
    if (!valid) {
      if (Date.now() > resetAt) { failures = 0; resetAt = Date.now() + 60000; }
      if (++failures > 20) { res.writeHead(429, { 'Retry-After': '60' }); res.end(); return; }
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Undeadbot", charset="UTF-8"' }); res.end('Acceso privado'); return;
    }
    if (req.url === '/api/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(getSnapshot())); return;
    }
    const asset = assets.get(req.url);
    if (!asset) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', asset[1]);
    res.end(fs.readFileSync(new URL(`../public/${asset[0]}`, import.meta.url)));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
