import { setTimeout as sleep } from 'node:timers/promises';
import { Workspace } from './workspace.js';
import { Agents } from './agents.js';
import { Store } from './store.js';
import { createDashboard } from './dashboard.js';
import { Api } from './api.js';
import { Bot } from './bot.js';

let server, workspace, unlock;
let stopping = false;
try {
  workspace = new Workspace();
  if (workspace.kind === 'file') unlock = new Store(workspace.directory).lock();
  await workspace.init();
  const agents = new Agents(workspace);
  const command = process.argv[2] || 'start';
  const slot = Number(process.env.AGENT_SLOT || 1);
  if (command === 'status') console.log(JSON.stringify(await agents.list(), null, 2));
  else if (command === 'check' || command === 'resume') {
    await workspace.run(async (data, save) => {
      const agent = data.agents.find(a => a.slot === slot);
      if (!agent) throw new Error('AGENT_SLOT no existe');
      if (command === 'resume') {
        if (Object.values(agent.state.days).some(d => Object.values(d).some(p => p.status === 'pending')) || agent.state.positions.some(p => p.status === 'closing')) throw new Error('Concilia las ordenes inciertas antes de reanudar');
        agent.state.paused = null; agent.monitor = null;
        agent.events.push({ at: new Date().toISOString(), event: 'resumed' }); await save();
      } else {
        const key = workspace.key(agent); if (!key) throw new Error('Falta conectar la API de este agente');
        const bot = new Bot({ api: new Api(key, fetch, agent.botId), store: { load: () => agent.state }, harness: agent.prompt, strategy: agent.strategy });
        const result = await bot.check(); console.log(JSON.stringify(result));
        if (!result.apiReady || !result.symbolsAvailable || result.balance < agent.strategy.margin * agent.strategy.symbols.length) process.exitCode = 1;
      }
    });
  } else if (command === 'start') {
    await workspace.run(data => { for (const agent of data.agents) agent.startedAt = new Date().toISOString(); });
    server = await createDashboard({ agents, password: process.env.DASHBOARD_PASSWORD, cronSecret: process.env.CRON_SECRET, port: Number(process.env.PORT || 3000) });
    console.log(JSON.stringify({ event: 'dashboard_started', port: server.address().port, storage: workspace.kind }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
    while (!stopping) { await agents.tick(); if (!stopping) await sleep(5000); }
  } else throw new Error('Comando desconocido');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await workspace?.close();
  unlock?.();
}
