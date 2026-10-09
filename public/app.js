const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
const time = value => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
let data;
let receivedAt = 0;
function alert(message, error = false) { const node = document.createElement('div'); node.className = `alert${error ? ' error' : ''}`; node.textContent = message; $('alerts').append(node); }
function cell(row, text, className) { const td = document.createElement('td'); td.textContent = text; if (className) td.className = className; row.append(td); return td; }
function render(value) {
  data = value; receivedAt = Date.now();
  $('balance').textContent = money(data.balance); $('equity').textContent = money(data.equity);
  $('positions-count').textContent = `${data.trackedOpen} / 3`;
  $('mode').textContent = data.mode === 'live' ? 'Automático' : 'Prueba';
  $('bot-status').textContent = data.paused ? 'Pausado · requiere revisión' : data.mode === 'live' ? 'Órdenes con saldo virtual' : 'Sin enviar órdenes';
  $('next-open').textContent = `${time(data.nextOpening)} · Monterrey`;
  $('harness').textContent = data.harness;
  $('updated').textContent = data.accountUpdatedAt ? `Cuenta consultada: ${new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(data.accountUpdatedAt))} · ${data.accountOpen} posiciones totales en la cuenta` : 'Esperando primera consulta a Undeadwallet';
  $('alerts').replaceChildren();
  if (data.paused) alert(`Bot pausado: ${data.paused}. Los cierres automáticos también están pausados.`, true);
  if (data.apiReady === false) alert('No se pudo validar la conexión con la API de Undeadwallet mediante /learn.', true);
  if (data.accountError) alert(`No se pudo actualizar la cuenta: ${data.accountError}. La lectura automática está detenida hasta reiniciar; los datos mostrados pueden estar desactualizados.`, true);
  if (data.mode !== 'live') alert('Modo de prueba: el bot muestra decisiones pero no abre ni cierra posiciones. Para operar configura BOT_MODE=live.');
  $('positions').replaceChildren();
  if (!data.positions.length) { const row = document.createElement('tr'); const td = cell(row, 'Todavía no hay posiciones del bot. La próxima entrada aparecerá aquí.', 'empty'); td.colSpan = 6; $('positions').append(row); }
  for (const p of data.positions) {
    const row = document.createElement('tr');
    const asset = cell(row, p.symbol); const id = document.createElement('small'); id.textContent = `#${p.id} · Long`; asset.append(id);
    cell(row, p.status === 'closed' ? 'Cerrada' : p.accountStatus === 'closed' ? 'Cerrada en cuenta' : p.status === 'closing' ? 'Cierre por revisar' : p.accountStatus === 'unknown' ? 'Pendiente de verificar' : 'Abierta');
    cell(row, `${money(p.margin)} / ${p.leverage}×`); cell(row, money(p.price));
    cell(row, money(p.pnl), p.pnl > 0 ? 'positive' : p.pnl < 0 ? 'negative' : ''); cell(row, p.closeAt);
    $('positions').append(row);
  }
  $('schedule').replaceChildren();
  const clock = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`;
  for (let base = 0; base < 86400; base += data.strategy.intervalSeconds) {
    const open = base + data.strategy.openingOffsetSeconds;
    const close = open + data.strategy.holdingSeconds;
    const slot = document.createElement('div'); slot.className = 'slot';
    if (data.local.seconds >= open && data.local.seconds < close) slot.classList.add('active');
    slot.textContent = `${clock(open)} → ${clock(close)}`; $('schedule').append(slot);
  }
  const labels = { opened: 'Posición abierta', closed: 'Posición cerrada', already_closed: 'Cierre conciliado', paused: 'Bot pausado', started: 'Bot iniciado', heartbeat: 'Bot activo', dry_run: 'Simulación sin órdenes', dashboard_started: 'Panel iniciado', entry_window_missed: 'Entrada omitida por horario' };
  $('events').replaceChildren();
  for (const event of data.events) { const li = document.createElement('li'); const at = document.createElement('time'); at.textContent = time(event.at); const text = document.createElement('span'); text.textContent = `${labels[event.event] || event.event}${event.symbol ? ` · ${event.symbol}` : ''}${event.id ? ` #${event.id}` : ''}${event.reason ? ` · ${event.reason}` : ''}`; li.append(at, text); $('events').append(li); }
  updateClock();
}
function updateClock() {
  if (!data) return;
  const now = new Date(new Date(data.now).getTime() + Date.now() - receivedAt);
  $('clock').textContent = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now);
  const remaining = Math.max(0, Math.floor((new Date(data.nextOpening) - now) / 1000));
  $('countdown').textContent = data.entering ? 'Ventana del ciclo actual en curso' : `En ${Math.floor(remaining / 3600)} h ${Math.floor(remaining % 3600 / 60)} min ${remaining % 60} s${data.nextOpeningBlocked ? ' · Sujeta a posiciones pendientes y reglas del bot' : ''}`;
}
async function poll() {
  try { const response = await fetch('/api/status', { cache: 'no-store' }); if (!response.ok) throw new Error('No disponible'); render(await response.json()); $('connection').textContent = '● Panel conectado'; }
  catch { $('connection').textContent = '○ Sin conexión · datos anteriores'; }
  finally { setTimeout(poll, 5000); }
}
setInterval(updateClock, 1000);
poll();
