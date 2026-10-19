import http from 'node:http';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { STRATEGY, localTime, nextOpening, clock, cycleAt } from './schedule.js';
import { validateAccount } from './bot.js';

export class Monitor {
  constructor(api, harness, now = () => new Date()) {
    this.api = api; this.harness = harness; this.now = now;
    this.account = null; this.updatedAt = null; this.error = null; this.apiReady = null; this.learnVersion = null;
    this.nextRead = 0; this.pending = null;
  }
  refresh() {
    if (this.pending || this.error || this.now().getTime() < this.nextRead) return;
    this.nextRead = this.now().getTime() + 60000;
    this.pending = (async () => {
      try {
        const learned = await this.api.learn();
        this.learnVersion = learned.learn_version;
        this.apiReady = true;
        this.account = validateAccount(await this.api.account());
        this.updatedAt = this.now().toISOString();
      } catch (error) { this.error = error.message; this.apiReady = false; }
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
    return { id: p.id, symbol: p.symbol, direction: p.direction || 'long', status: p.status, day: p.day, cycle: p.cycle ?? 'Estrategia diaria anterior',
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
  return { now: now.toISOString(), mode: bot.mode, paused: bot.state.paused, strategy: bot.strategy || STRATEGY,
    local: current, nextOpening: nextOpening(now), entering, nextOpeningBlocked: Boolean(bot.state.paused || tracked.length || monitor.apiReady !== true),
    balance: account?.balance_usdg ?? null, equity: Number.isFinite(account?.equity_usdg) ? account.equity_usdg : null,
    accountUpdatedAt: monitor.updatedAt, accountError: monitor.error, apiReady: monitor.apiReady, learnVersion: monitor.learnVersion,
    harness: bot.harness, positions: [...tracked, ...positions.filter(p => p.status === 'closed').reverse()],
    trackedOpen: tracked.length, accountOpen: account?.open.length ?? null, events: [...events].reverse() };
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
export function dashboardHandler({ getSnapshot, password, agents, cronSecret }) {
  const expected = createHash('sha256').update(`admin:${password || ''}`).digest();
  let failures = 0; let resetAt = 0;
  return async (req, res) => {
    try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    if (route === '/api/cron' && agents) {
      const bearer = createHash('sha256').update(req.headers.authorization || '').digest();
      const secret = createHash('sha256').update(`Bearer ${cronSecret || ''}`).digest();
      if (req.method !== 'GET' || !cronSecret || !timingSafeEqual(bearer, secret)) { res.writeHead(401); res.end(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await agents.tick())); return;
    }
    if (!agents && req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
    if (!password || password.length < 12) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Panel pendiente: configura DASHBOARD_PASSWORD con al menos 12 caracteres en .env o en las variables de Railway/Vercel. Usuario: admin.'); return;
    }
    const authorization = req.headers.authorization || '';
    const credentials = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString('utf8') : '';
    const valid = timingSafeEqual(expected, createHash('sha256').update(credentials).digest());
    if (!valid) {
      if (Date.now() > resetAt) { failures = 0; resetAt = Date.now() + 60000; }
      if (++failures > 20) { res.writeHead(429, { 'Retry-After': '60' }); res.end(); return; }
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Undeadbot", charset="UTF-8"' }); res.end('Acceso privado'); return;
    }
    if (agents && route.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'GET' && route === '/api/agents') { res.end(JSON.stringify(await agents.list())); return; }
      const match = route.match(/^\/api\/agents\/([a-f0-9-]+)$/);
      if (req.method === 'POST' || req.method === 'PUT') {
        const origin = req.headers.origin;
        if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end('{}'); return; }
        if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415); res.end('{}'); return; }
        let raw = '';
        if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
        else for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 40000) break; }
        if (Buffer.byteLength(raw) > 40000) { res.writeHead(413); res.end('{}'); return; }
        let input; try { input = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":"JSON inválido"}'); return; }
        if (!input || typeof input !== 'object' || Array.isArray(input)) { res.writeHead(400); res.end('{}'); return; }
        if (req.method === 'POST' && route === '/api/agents') { const result = await agents.create(input); res.writeHead(201); res.end(JSON.stringify(result)); return; }
        if (req.method === 'PUT' && match) { res.end(JSON.stringify(await agents.update(match[1], input))); return; }
      }
      res.writeHead(404); res.end('{}'); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (req.url === '/api/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(getSnapshot())); return;
    }
    const asset = assets.get(route);
    if (!asset) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', asset[1]);
    res.end(fs.readFileSync(new URL(`../public/${asset[0]}`, import.meta.url)));
    } catch (error) {
      if (!res.headersSent) res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.status ? error.message : 'No se pudo completar la solicitud. Revisa el almacenamiento y la configuración del servidor.' }));
    }
  };
}
export function createDashboard(options) {
  const { host = '0.0.0.0', port = 3000 } = options;
  const server = http.createServer(dashboardHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
