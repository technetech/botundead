const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
const time = value => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const dateTime = value => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
let state, selected, tab = 'activity', dirty = false, eventLimit = 30, positionLimit = 30, saving = false;
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
function notice(message, error = false) { $('notice').replaceChildren(node('div', message, `alert${error ? ' error' : ''}`)); }
async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || (response.status === 401 ? 'Inicia sesión para continuar.' : 'No se pudo completar la solicitud.'));
  return result;
}
function status(agent) { return agent.paused ? ['Requiere revisión', 'error'] : agent.accountError ? ['Error de conexión', 'error'] : !agent.connection.configured ? ['Sin conexión API', ''] : !agent.enabled ? ['Desactivado', ''] : agent.mode === 'live' ? ['Automático', 'running'] : ['En prueba', 'running']; }
function renderHome() {
  $('agent-total').textContent = state.agents.length; $('agent-badge').textContent = state.agents.length;
  $('active-total').textContent = state.agents.filter(a => a.enabled && !a.paused).length;
  $('storage-label').textContent = `${state.storage === 'postgres' ? 'PostgreSQL' : 'Almacenamiento local'} · Historial persistente`;
  $('footer-storage').textContent = `${state.execution === 'cron' ? 'Ejecución por cron' : 'Motor continuo'} · Panel cada 5 s`;
  $('new-agent').hidden = state.agents.length >= state.limit;
  $('agent-grid').replaceChildren();
  for (const agent of state.agents) {
    const card = node('a', undefined, 'agent-card'); card.href = `#agent/${agent.id}`;
    const top = node('div', undefined, 'card-top'); const [label, cls] = status(agent);
    top.append(node('span', String(agent.slot).padStart(2, '0'), 'agent-avatar'), node('span', label, `status ${cls}`));
    const stats = node('div', undefined, 'card-metrics');
    for (const [value, label] of [[agent.trackedOpen, 'posiciones abiertas'], [agent.events.length, 'eventos guardados']]) { const item = node('div'); item.append(node('strong', value), node('small', label)); stats.append(item); }
    const bottom = node('div', undefined, 'card-bottom'); bottom.append(node('span', `${agent.strategy.symbols.join(' · ')} / ${agent.strategy.direction.toUpperCase()}`), node('span', 'Abrir agente ↗'));
    card.append(top, node('h2', agent.name), node('p', agent.prompt, 'card-description'), stats, bottom); $('agent-grid').append(card);
  }
  if (state.agents.length < state.limit) {
    const add = node('button', undefined, 'agent-card add-card'); add.type = 'button'; add.append(node('span', '+', 'plus'), node('strong', 'Nuevo agente'), node('p', `${state.limit - state.agents.length} espacios disponibles para tu próxima estrategia.`)); add.onclick = openCreate; $('agent-grid').append(add);
  }
}
function fillForm(a) {
  $('agent-name').value = a.name; $('agent-prompt').value = a.prompt; $('symbols').value = a.strategy.symbols.join(', ');
  $('margin').value = a.strategy.margin; $('leverage').value = a.strategy.leverage; $('direction').value = a.strategy.direction;
  $('config-mode').value = a.mode; $('enabled').checked = a.enabled; $('api-key').value = ''; $('remove-key').checked = false;
}
function cell(row, text, className) { const td = node('td', text, className); row.append(td); return td; }
function renderDetail(a) {
  $('agent-slot').textContent = `ESPACIO ${String(a.slot).padStart(2, '0')} / AGENTE`;
  $('agent-title').textContent = a.name; $('agent-subtitle').textContent = `${a.strategy.symbols.join(', ')} · ${a.strategy.direction.toUpperCase()} · ${a.strategy.leverage}× · America/Monterrey`;
  $('agent-status').textContent = status(a)[0];
  $('balance').textContent = money(a.balance); $('equity').textContent = money(a.equity); $('positions-count').textContent = a.trackedOpen;
  $('mode').textContent = a.mode === 'live' ? 'Automático' : 'Prueba';
  $('updated').textContent = a.accountUpdatedAt ? `Consulta: ${dateTime(a.accountUpdatedAt)}` : 'Esperando primera lectura';
  $('next-open').textContent = `${time(a.nextOpening)} h`;
  $('allocation').textContent = `${money(a.strategy.margin)} USDG / activo`;
  $('allocation-detail').textContent = `${money(a.strategy.margin * a.strategy.symbols.length)} USDG de margen total · ${a.strategy.leverage}×`;
  $('countdown').textContent = !a.enabled ? 'Activa el agente desde Estrategia para ejecutar sus reglas.' : a.paused ? 'Ejecución pausada. Requiere conciliación.' : `Siguiente ciclo: ${dateTime(a.nextOpening)}${a.nextOpeningBlocked ? ' · Sujeto a conexión y posiciones pendientes' : ''}`;
  $('api-state').textContent = a.connection.configured ? 'CLAVE CONFIGURADA' : 'SIN CONFIGURAR';
  $('api-source').textContent = a.connection.source === 'environment' ? 'VARIABLE DE ENTORNO' : a.connection.source === 'panel' ? 'GUARDADA EN EL PANEL' : 'PENDIENTE';
  $('env-help').textContent = `También puedes configurar AGENT_${a.slot}_UNDEAD_API_KEY en .env o en las variables de Railway / Vercel.${a.slot === 1 ? ' El primer agente también admite UNDEAD_API_KEY.' : ''}`;
  $('agent-alerts').replaceChildren();
  if (a.paused) $('agent-alerts').append(node('div', `Agente pausado: ${a.paused}. Los cierres también están pausados. Revisa la conciliación en README.`, 'alert error'));
  if (a.accountError) $('agent-alerts').append(node('div', `Error de conexión: ${a.accountError}. Los datos pueden estar desactualizados. Guarda la configuración, cuando no haya posiciones pendientes, o usa resume para restablecer las lecturas.`, 'alert error'));
  if (state.execution === 'cron') $('agent-alerts').append(node('div', 'Las órdenes dependen del cron del despliegue, incluso si cierras este panel. Requiere programación cada minuto.', 'alert'));
  if (!dirty) fillForm(a);
  renderHistory(a);
}
function renderHistory(a) {
  const filter = $('position-filter').value;
  const positions = a.positions.filter(p => filter === 'all' || (filter === 'closed' ? p.status === 'closed' : p.status !== 'closed'));
  $('positions').replaceChildren();
  if (!positions.length) { const row = node('tr'); cell(row, 'Sin posiciones en esta vista. Las operaciones del agente aparecerán aquí.', 'empty').colSpan = 6; $('positions').append(row); }
  for (const p of positions.slice(0, positionLimit)) {
    const row = node('tr'); const asset = cell(row, p.symbol); asset.append(node('small', `#${p.id} · ${(p.direction || 'long').toUpperCase()}`));
    cell(row, p.status === 'closed' ? 'Cerrada' : p.status === 'closing' ? 'Por conciliar' : 'Abierta'); cell(row, `${money(p.margin)} / ${p.leverage}×`); cell(row, money(p.price)); cell(row, money(p.pnl), p.pnl > 0 ? 'positive' : p.pnl < 0 ? 'negative' : ''); cell(row, p.closeAt); $('positions').append(row);
  }
  $('more-positions').hidden = positions.length <= positionLimit;
  const labels = { configuration_updated: 'Configuración actualizada', opened: 'Posición abierta', closed: 'Posición cerrada', already_closed: 'Cierre conciliado', paused: 'Agente pausado', started: 'Agente iniciado', dry_run: 'Decisión en modo prueba', resumed: 'Pausa resuelta', entry_window_missed: 'Entrada omitida por horario', api_heartbeat: 'Conexión activa', api_version: 'Versión de API verificada', agent_error: 'Error del agente' };
  $('events').replaceChildren();
  if (!a.events.length) $('events').append(node('li', 'Todavía no hay actividad. Configura tu agente para empezar.', 'muted'));
  for (const e of a.events.slice(0, eventLimit)) { const item = node('li'); item.append(node('time', dateTime(e.at)), node('span', `${labels[e.event] || e.event}${e.symbol ? ` · ${e.symbol}` : ''}${e.id ? ` #${e.id}` : ''}${e.reason ? ` · ${e.reason}` : ''}`)); $('events').append(item); }
  $('more-events').hidden = a.events.length <= eventLimit;
}
function selectTab(value) {
  tab = value;
  for (const name of ['activity', 'strategy', 'connections']) $(`${name}-tab`).hidden = name !== tab;
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('selected', button.dataset.tab === tab); button.setAttribute('aria-pressed', String(button.dataset.tab === tab)); });
  $('save-bar').hidden = tab === 'activity';
}
function route() {
  if (!state) return;
  const id = location.hash.startsWith('#agent/') ? location.hash.slice(7) : '';
  const agent = state.agents.find(a => a.id === id);
  if (selected !== agent?.id) { selected = agent?.id; dirty = false; eventLimit = 30; positionLimit = 30; $('notice').replaceChildren(); selectTab('activity'); }
  $('home').hidden = Boolean(agent); $('detail').hidden = !agent;
  if (agent) renderDetail(agent); else renderHome();
}
function openCreate() { $('new-name').value = ''; $('create-error').textContent = ''; $('create-dialog').showModal(); $('new-name').focus(); }
$('new-agent').onclick = openCreate; $('cancel-create').onclick = () => $('create-dialog').close();
$('create-form').onsubmit = async event => {
  event.preventDefault(); $('confirm-create').disabled = true;
  try { const result = await request('/api/agents', 'POST', { name: $('new-name').value }); $('create-dialog').close(); state = await request('/api/agents'); location.hash = `agent/${result.id}`; route(); selectTab('strategy'); }
  catch (error) { $('create-error').textContent = error.message; }
  finally { $('confirm-create').disabled = false; }
};
$('config-form').addEventListener('input', () => { dirty = true; $('save-hint').textContent = 'Tienes cambios sin guardar.'; });
$('config-form').onsubmit = async event => {
  event.preventDefault(); if (saving) return;
  saving = true; $('save-agent').disabled = true;
  try {
    const input = { name: $('agent-name').value, prompt: $('agent-prompt').value, symbols: $('symbols').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean), margin: Number($('margin').value), leverage: Number($('leverage').value), direction: $('direction').value, mode: $('config-mode').value, enabled: $('enabled').checked, apiKey: $('api-key').value, removeKey: $('remove-key').checked };
    const result = await request(`/api/agents/${selected}`, 'PUT', input);
    state.agents[state.agents.findIndex(a => a.id === selected)] = result; dirty = false; renderDetail(result); $('save-hint').textContent = 'Configuración guardada.'; notice('Configuración y conexión guardadas.');
  } catch (error) { notice(error.message, true); }
  finally { saving = false; $('save-agent').disabled = false; }
};
document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => selectTab(button.dataset.tab); });
$('position-filter').onchange = () => { positionLimit = 30; renderHistory(state.agents.find(a => a.id === selected)); };
$('more-events').onclick = () => { eventLimit += 50; renderHistory(state.agents.find(a => a.id === selected)); };
$('more-positions').onclick = () => { positionLimit += 50; renderHistory(state.agents.find(a => a.id === selected)); };
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
async function poll() {
  try { if (!saving) { state = await request('/api/agents'); route(); } $('connection').textContent = '● Panel conectado'; }
  catch (error) { $('connection').textContent = '○ Sin conexión'; if (!state) notice(error.message, true); }
  finally { setTimeout(poll, 5000); }
}
poll();
