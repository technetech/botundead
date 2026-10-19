import { Workspace } from '../src/workspace.js';
import { Agents } from '../src/agents.js';
import { dashboardHandler } from '../src/dashboard.js';

let ready;
export default async function handler(req, res) {
  try {
    ready ||= (async () => {
      const workspace = await new Workspace().init();
      return dashboardHandler({ agents: new Agents(workspace), password: process.env.DASHBOARD_PASSWORD, cronSecret: process.env.CRON_SECRET });
    })().catch(error => { ready = null; throw error; });
    await (await ready)(req, res);
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Configura DATABASE_URL y revisa la conexión PostgreSQL del despliegue.' }));
  }
}
