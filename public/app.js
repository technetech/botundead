const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
const time = value => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const dateTime = value => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
let state, selected, tab = 'activity', dirty = false, eventLimit = 30, positionLimit = 30, saving = false, deleting;
let entries = [], connections = [];
const catalogs = new Map();
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
function notice(message, error = false) { $('notice').replaceChildren(node('div', message, `alert${error ? ' error' : ''}`)); }
function changed() { dirty = true; $('save-hint').textContent = 'Tienes cambios sin guardar.'; }
async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, cache: 'no-store', ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || (response.status === 401 ? 'Inicia sesión para continuar.' : 'No se pudo completar la solicitud.'));
  return result;
}
function status(a) { return a.paused ? ['Requiere revisión', 'error'] : a.accountError ? ['Error de conexión', 'error'] : !a.connection.configured ? ['Sin conexión API', ''] : !a.execution?.ready ? ['Configuración pendiente', ''] : a.enabled && a.mode === 'live' ? ['En marcha', 'running'] : ['Listo para guardar', '']; }
function renderHome() {
  $('agent-total').textContent = state.agents.length; $('agent-badge').textContent = state.agents.length;
  $('active-total').textContent = state.agents.filter(a => a.enabled && !a.paused).length;
  $('storage-label').textContent = `${state.storage === 'postgres' ? 'PostgreSQL' : 'Almacenamiento local'} · Historial persistente`;
  $('footer-storage').textContent = `${state.execution === 'cron' ? 'Ejecución por cron' : 'Motor continuo'} · Panel cada 5 s`;
  $('new-agent').hidden = state.agents.length >= state.limit;
  $('agent-grid').replaceChildren();
  for (const a of state.agents) {
    const card = node('article', undefined, 'agent-card'); const top = node('div', undefined, 'card-top'); const [label, cls] = status(a);
    const actions = node('div', undefined, 'card-actions'); const remove = node('button', '×', 'icon-button'); remove.type = 'button'; remove.setAttribute('aria-label', `Eliminar espacio ${a.name}`); remove.title = 'Eliminar espacio'; remove.onclick = () => openDelete(a);
    actions.append(node('span', label, `status ${cls}`), remove);
    top.append(node('span', String(a.slot).padStart(2, '0'), 'agent-avatar'), actions);
    const title = node('h2'); const titleLink = node('a', a.name, 'card-title'); titleLink.href = `#agent/${a.id}`; title.append(titleLink);
    const stats = node('div', undefined, 'card-metrics');
    for (const [value, label] of [[money(a.initialCapital), 'capital inicial · USDG'], [a.trackedOpen, 'posiciones abiertas']]) { const item = node('div'); item.append(node('strong', value), node('small', label)); stats.append(item); }
    const bottom = node('div', undefined, 'card-bottom'); const link = node('a', 'Abrir agente ↗', 'card-open'); link.href = `#agent/${a.id}`;
    bottom.append(node('span', a.engine === 'agent' ? 'MODO AGENTE · IA' : 'MODO BOT · REGLAS'), link);
    card.append(top, title, node('p', a.prompt, 'card-description'), stats, bottom); $('agent-grid').append(card);
  }
  if (state.agents.length < state.limit) { const add = node('button', undefined, 'agent-card add-card'); add.type = 'button'; add.append(node('span', '+', 'plus'), node('strong', 'Nuevo agente'), node('p', `${state.limit - state.agents.length} espacios disponibles para tu próxima estrategia.`)); add.onclick = openCreate; $('agent-grid').append(add); }
}
function engineChoice() {
  const agentMode = $('engine-agent').checked;
  $('agent-engine-option').classList.toggle('chosen', agentMode); $('bot-engine-option').classList.toggle('chosen', !agentMode);
  $('bot-controls').hidden = agentMode;
  $('prompt-help').textContent = agentMode ? 'La IA evalúa esta instrucción con los datos disponibles. Conecta su API y modelo para activar la ejecución.' : 'Esta instrucción se conserva para el modo Agente. En modo Bot se ejecutan las posiciones configuradas abajo.';
}
function fillForm(a) {
  $('agent-name').value = a.name; $('agent-prompt').value = a.prompt;
  $('engine-agent').checked = a.engine === 'agent'; $('engine-bot').checked = a.engine !== 'agent';
  $('api-key').value = ''; $('remove-key').checked = false;
  entries = (a.strategy.entries || a.strategy.symbols.map(symbol => ({ symbol, margin: a.strategy.margin, leverage: a.strategy.leverage, direction: a.strategy.direction || 'long' }))).map(p => ({ ...p }));
  connections = (a.connections || []).map(c => ({ ...c, apiKey: '', removeKey: false }));
  engineChoice(); renderEntries(); renderConnections();
}
function field(title, control) { const label = node('label', title); label.append(control); return label; }
function selectOptions(options, value) { const select = node('select'); for (const [key,label] of options) { const option = node('option',label); option.value = key; select.append(option); } select.value = value; return select; }
function assetGroup(kind) { return /crypto/i.test(kind) ? 'crypto' : /stock|equity|accion|acción/i.test(kind) ? 'stock' : 'other'; }
function renderEntries() {
  const catalog = catalogs.get(selected); const assets = catalog?.assets || [];
  $('asset-message').textContent = catalog?.pending ? 'Consultando los activos de Undeadwallet…' : catalog?.error || (assets.length ? `${assets.length} activos recibidos de Undeadwallet. Elige criptomonedas, acciones / stocks u otros activos disponibles.` : 'Conecta y guarda la API de Undeadwallet para cargar su catálogo.');
  $('bot-entries').replaceChildren();
  entries.forEach((entry,index) => {
    const row = node('div',undefined,'position-editor');
    const actual = assets.find(a => a.symbol === entry.symbol);
    const group = entry.category || (actual ? assetGroup(actual.kind) : 'crypto');
    const category = selectOptions([['crypto','Criptomonedas'],['stock','Acciones / stocks'],['other','Otros activos']],group);
    category.setAttribute('aria-label',`Tipo de activo de posición ${index+1}`);
    category.onchange = () => { entry.category = category.value; entry.symbol = ''; changed(); renderEntries(); };
    const options = [['','Selecciona un activo'], ...assets.filter(a => assetGroup(a.kind) === group).map(a => [a.symbol,`${a.symbol} · ${a.name}`])];
    if (entry.symbol && !options.some(([symbol]) => symbol === entry.symbol)) options.push([entry.symbol,`${entry.symbol} · ${assets.length ? 'No disponible en este catálogo' : 'Pendiente de verificar'}`]);
    const symbol = selectOptions(options,entry.symbol); symbol.setAttribute('aria-label',`Activo de posición ${index+1}`); symbol.onchange = () => { entry.symbol = symbol.value; changed(); };
    const margin = node('input'); margin.type = 'number'; margin.min = '.01'; margin.max = '1000000'; margin.step = '.01'; margin.value = entry.margin; margin.setAttribute('aria-label',`Margen de posición ${index+1}`); margin.oninput = () => { entry.margin = Number(margin.value); changed(); entryTotal(); };
    const leverage = node('input'); leverage.type = 'number'; leverage.min = '1'; leverage.max = '100'; leverage.value = entry.leverage; leverage.setAttribute('aria-label',`Apalancamiento de posición ${index+1}`); leverage.oninput = () => { entry.leverage = Number(leverage.value); changed(); };
    const direction = selectOptions([['long','Long'],['short','Short']],entry.direction); direction.setAttribute('aria-label',`Dirección de posición ${index+1}`); direction.onchange = () => { entry.direction = direction.value; changed(); };
    const remove = node('button','Quitar','secondary remove-position'); remove.type = 'button'; remove.setAttribute('aria-label',`Quitar posición ${index+1}`); remove.onclick = () => { entries.splice(index,1); changed(); renderEntries(); };
    row.append(field('Mercado',category),field('Activo',symbol),field('Margen · USDG',margin),field('Apalancamiento',leverage),field('Dirección',direction),remove); $('bot-entries').append(row);
  });
  if (!entries.length) $('bot-entries').append(node('p','Añade una posición para configurar el modo Bot.','muted'));
  $('add-position').disabled = entries.length >= 10; entryTotal();
}
function entryTotal() { $('entry-total').textContent = `${entries.length} / 10 posiciones · ${money(entries.reduce((sum,p) => sum + (Number(p.margin)||0),0))} USDG de margen total`; }
async function loadAssets(force = false) {
  if (!selected) return; const id = selected; const a = state.agents.find(a => a.id === id);
  if (!a?.connection.configured) { catalogs.set(id,{error:'Conecta y guarda primero la API de Undeadwallet en Conexiones API.'}); renderEntries(); return; }
  if (catalogs.get(id)?.pending || (!force && catalogs.has(id))) return;
  catalogs.set(id,{pending:true}); renderEntries();
  try { const result = await request(`/api/agents/${id}/assets`); catalogs.set(id,result); }
  catch(error) { catalogs.set(id,{error:error.message}); }
  if (selected === id) renderEntries();
}
function renderConnections() {
  $('extra-connections').replaceChildren();
  connections.forEach((c,index) => {
    const card = node('section',undefined,'panel connection-editor'); const heading = node('div',undefined,'section-heading');
    const remove = node('button','Quitar API','secondary'); remove.type='button'; remove.onclick=()=>{connections.splice(index,1);changed();renderConnections();};
    heading.append(node('h2',`Conexión ${index+1}`),remove); card.append(heading);
    const grid = node('div',undefined,'form-grid');
    const kind = selectOptions([['ai','IA · NVIDIA / compatible'],['data','API de datos · GET JSON']],c.kind);
    kind.onchange=()=>{c.kind=kind.value;if(c.kind==='ai'){c.auth='bearer';if(!c.url)c.url='https://integrate.api.nvidia.com/v1';}changed();renderConnections();}; grid.append(field('Tipo de conexión',kind));
    function textField(label,property,type='text',placeholder='') { const input=node('input');input.type=type;input.value=c[property]||'';input.placeholder=placeholder;if(type==='password')input.autocomplete='new-password';input.oninput=()=>{c[property]=input.value;changed();};return field(label,input); }
    grid.append(textField('Nombre','name','text','Ej. NVIDIA o noticias'),textField(c.kind==='ai'?'URL base de IA':'URL de consulta JSON','url','url',c.kind==='ai'?'https://integrate.api.nvidia.com/v1':'https://api.ejemplo.com/datos'));
    if(c.kind==='ai')grid.append(textField('Modelo','model','text','Nombre exacto de tu modelo'));
    const auth = selectOptions(c.kind==='ai'?[['bearer','Bearer token']]:[['none','Sin autenticación'],['bearer','Bearer token'],['header','Encabezado personalizado']],c.auth);
    auth.onchange=()=>{c.auth=auth.value;changed();renderConnections();};grid.append(field('Autenticación',auth));
    if(c.auth==='header')grid.append(textField('Nombre del encabezado','header','text','X-API-Key'));
    if(c.auth!=='none')grid.append(textField('API key / token nuevo','apiKey','password',c.configured?'Guardada · dejar vacío para conservar':'Introduce la clave'),textField('Variable de entorno (opcional)','envKey','text',c.kind==='ai'?'NVIDIA_API_KEY':'NEWS_API_KEY'));
    card.append(grid);
    const line=node('p',c.source==='environment'?'Credencial desde variable de entorno':c.configured?'Credencial guardada en el servidor':'Conexión nueva: se aplicará al guardar','help');card.append(line);
    if(c.configured && c.auth!=='none'){ const check=node('input');check.type='checkbox';check.checked=c.removeKey;check.onchange=()=>{c.removeKey=check.checked;changed();};const label=node('label',undefined,'check');label.append(check,node('span','Quitar credencial guardada'));card.append(label); }
    $('extra-connections').append(card);
  });
  if(!connections.length)$('extra-connections').append(node('p','Sin APIs adicionales. Usa Añadir API para conectar NVIDIA u otra fuente de datos.','empty'));
  $('add-api').disabled=connections.length>=10;
}
function cell(row, text, className) { const td = node('td', text, className); row.append(td); return td; }
function renderDetail(a) {
  $('agent-slot').textContent = `ESPACIO ${String(a.slot).padStart(2,'0')} / ${a.engine==='agent'?'MODO AGENTE':'MODO BOT'}`;
  $('agent-title').textContent = a.name; $('agent-subtitle').textContent = `${a.engine==='agent'?'Decisiones dirigidas por tu instrucción':'Estrategia programada'} · Capital inicial: ${money(a.initialCapital)} USDG`;
  $('capital-badge').textContent=`CAPITAL: ${money(a.initialCapital)} USDG`;
  $('agent-status').textContent = status(a)[0];
  $('balance').textContent = money(a.balance); $('equity').textContent = money(a.equity); $('positions-count').textContent = a.trackedOpen;
  $('mode').textContent = a.paused ? 'Pausado' : a.enabled && a.mode === 'live' ? 'En marcha' : 'Por configurar';
  $('updated').textContent = a.accountUpdatedAt ? `Consulta: ${dateTime(a.accountUpdatedAt)}` : 'Esperando primera lectura';
  $('schedule-label').textContent=a.engine==='agent'?'EVALUACIÓN DE LA ESTRATEGIA':'PRÓXIMA APERTURA · MONTERREY';
  $('next-open').textContent = a.engine==='agent'?'Modo Agente':`${time(a.nextOpening)} h`;
  const total=a.strategy.entries?a.strategy.entries.reduce((sum,p)=>sum+p.margin,0):a.strategy.margin*a.strategy.symbols.length;
  $('allocation').textContent = a.engine==='agent'?`${money(a.initialCapital)} USDG`:`${money(total)} USDG de margen`;
  $('allocation-detail').textContent = a.engine==='agent'?'Presupuesto del espacio · decisiones registradas':`${a.strategy.symbols.join(' · ')} · ${a.strategy.entries?.length||a.strategy.symbols.length} posiciones configuradas`;
  $('allocation-note').textContent=a.engine==='agent'?'Consulta de IA como máximo una vez por minuto':'Ciclos cada 2 horas · cierre a los 90 minutos';
  $('countdown').textContent = !a.enabled ? (a.execution?.missing?.length ? a.execution.missing.join(' · ') : 'Guarda la configuración para comenzar a operar.') : a.paused ? 'Ejecución pausada. Requiere conciliación.' : a.engine==='agent'?'La IA evalúa tu instrucción, las posiciones y las APIs conectadas.':`Siguiente ciclo: ${dateTime(a.nextOpening)}${a.nextOpeningBlocked?' · Sujeto a conexión y posiciones pendientes':''}`;
  $('api-state').textContent = a.connection.configured ? 'CLAVE CONFIGURADA' : 'SIN CONFIGURAR';
  $('api-source').textContent = a.connection.source === 'environment' ? 'VARIABLE DE ENTORNO' : a.connection.source === 'panel' ? 'GUARDADA EN EL PANEL' : 'PENDIENTE';
  $('env-help').textContent = `Variable del espacio: AGENT_${a.slot}_UNDEAD_API_KEY.${a.slot===1?' También admite UNDEAD_API_KEY.':''}`;
  $('agent-alerts').replaceChildren();
  if(a.paused)$('agent-alerts').append(node('div',`Espacio pausado: ${a.paused}. Revisa la conciliación en README.`,'alert error'));
  if(a.accountError)$('agent-alerts').append(node('div',`Error de conexión: ${a.accountError}. La fecha indica la última lectura disponible.`,'alert error'));
  if(state.execution==='cron')$('agent-alerts').append(node('div','La ejecución depende del cron del despliegue, incluso con el panel cerrado.','alert'));
  if(!dirty)fillForm(a); renderHistory(a);
}
function renderHistory(a) {
  const filter=$('position-filter').value;const positions=a.positions.filter(p=>filter==='all'||(filter==='closed'?p.status==='closed':p.status!=='closed'));
  $('positions').replaceChildren();if(!positions.length){const row=node('tr');cell(row,'Sin posiciones en esta vista. Las operaciones del espacio aparecerán aquí.','empty').colSpan=6;$('positions').append(row);}
  for(const p of positions.slice(0,positionLimit)){const row=node('tr');const asset=cell(row,p.symbol);asset.append(node('small',`#${p.id} · ${(p.direction||'long').toUpperCase()}`));cell(row,p.status==='closed'?'Cerrada':p.status==='closing'?'Por conciliar':'Abierta');cell(row,`${money(p.margin)} / ${p.leverage}×`);cell(row,money(p.price));cell(row,money(p.pnl),p.pnl>0?'positive':p.pnl<0?'negative':'');cell(row,p.closeAt);$('positions').append(row);}
  $('more-positions').hidden=positions.length<=positionLimit;
  const labels={configuration_updated:'Configuración actualizada',agent_decision:'Decisión del agente',opened:'Posición abierta',closed:'Posición cerrada',already_closed:'Cierre conciliado',paused:'Espacio pausado',started:'Espacio iniciado',dry_run:'Propuesta en modo prueba',resumed:'Pausa resuelta',entry_window_missed:'Entrada omitida por horario',api_heartbeat:'Conexión activa',api_version:'Versión de API verificada',agent_error:'Error del espacio'};
  $('events').replaceChildren();if(!a.events.length)$('events').append(node('li','Todavía no hay actividad. Configura tu espacio para empezar.','muted'));
  for(const e of a.events.slice(0,eventLimit)){const item=node('li');item.append(node('time',dateTime(e.at)),node('span',`${labels[e.event]||e.event}${e.symbol?` · ${e.symbol}`:''}${e.id?` #${e.id}`:''}${e.reason?` · ${e.reason}`:''}`));$('events').append(item);}$('more-events').hidden=a.events.length<=eventLimit;
}
function selectTab(value){tab=value;for(const name of ['activity','strategy','connections'])$(`${name}-tab`).hidden=name!==tab;document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('selected',b.dataset.tab===tab);b.setAttribute('aria-pressed',String(b.dataset.tab===tab));});$('save-bar').hidden=tab==='activity';if(tab==='strategy')loadAssets();}
function route(){if(!state)return;const id=location.hash.startsWith('#agent/')?location.hash.slice(7):'';const a=state.agents.find(a=>a.id===id);if(selected!==a?.id){selected=a?.id;dirty=false;eventLimit=30;positionLimit=30;$('notice').replaceChildren();selectTab('activity');}$('home').hidden=Boolean(a);$('detail').hidden=!a;if(a)renderDetail(a);else renderHome();}
function openCreate(){$('new-name').value='';$('new-capital').value='1000';$('create-error').textContent='';$('create-dialog').showModal();$('new-name').focus();}
function openDelete(a){deleting=a;$('delete-description').textContent=`Se quitará el espacio «${a.name}» de tus tarjetas. No cierra posiciones ni modifica el saldo de Undeadwallet.`;$('delete-error').textContent=a.canDelete?'': 'Primero cierra o concilia sus posiciones pendientes para no dejarlas sin gestionar.';$('confirm-delete').disabled=!a.canDelete;$('delete-dialog').showModal();}
$('new-agent').onclick=openCreate;$('cancel-create').onclick=()=>$('create-dialog').close();$('cancel-delete').onclick=()=>$('delete-dialog').close();
$('create-form').onsubmit=async e=>{e.preventDefault();$('confirm-create').disabled=true;try{const a=await request('/api/agents','POST',{name:$('new-name').value,initialCapital:Number($('new-capital').value)});$('create-dialog').close();state=await request('/api/agents');location.hash=`agent/${a.id}`;route();selectTab('strategy');}catch(error){$('create-error').textContent=error.message;}finally{$('confirm-create').disabled=false;}};
$('delete-form').onsubmit=async e=>{e.preventDefault();$('confirm-delete').disabled=true;try{await request(`/api/agents/${deleting.id}`,'DELETE',{});$('delete-dialog').close();state=await request('/api/agents');route();notice('Espacio eliminado. Su registro se conserva archivado.');}catch(error){$('delete-error').textContent=error.message;}finally{$('confirm-delete').disabled=false;}};
$('config-form').addEventListener('input',changed);
$('engine-agent').onchange=$('engine-bot').onchange=()=>{engineChoice();changed();};
$('add-position').onclick=()=>{entries.push({symbol:'',margin:25,leverage:1,direction:'long',category:'crypto'});changed();renderEntries();};
$('refresh-assets').onclick=()=>loadAssets(true);
$('add-api').onclick=()=>{connections.push({name:connections.some(c=>c.kind==='ai')?'Fuente de datos':'NVIDIA',kind:connections.some(c=>c.kind==='ai')?'data':'ai',url:connections.some(c=>c.kind==='ai')?'':'https://integrate.api.nvidia.com/v1',model:'',auth:connections.some(c=>c.kind==='ai')?'none':'bearer',apiKey:'',envKey:''});changed();renderConnections();};
$('config-form').onsubmit=async e=>{e.preventDefault();if(saving)return;saving=true;$('save-agent').disabled=true;try{const input={name:$('agent-name').value,prompt:$('agent-prompt').value,engine:$('engine-agent').checked?'agent':'bot',entries:entries.map(({symbol,margin,leverage,direction})=>({symbol,margin,leverage,direction})),autoStart:true,apiKey:$('api-key').value,removeKey:$('remove-key').checked,connections:connections.map(({id,name,kind,url,model,auth,header,envKey,apiKey,removeKey})=>({id,name,kind,url,model,auth,header,envKey,apiKey,removeKey}))};const a=await request(`/api/agents/${selected}`,'PUT',input);state.agents[state.agents.findIndex(a=>a.id===selected)]=a;dirty=false;catalogs.delete(selected);renderDetail(a);const message=a.paused?'Configuración guardada. El espacio sigue pausado y requiere revisión.':a.enabled?'Configuración guardada. El espacio ya está en marcha con USDG virtuales.':`Configuración guardada. Falta: ${a.execution.missing.join(' · ')}.`;$('save-hint').textContent=message;notice(message);if(tab==='strategy')loadAssets();}catch(error){notice(error.message,true);}finally{saving=false;$('save-agent').disabled=false;}};
document.querySelectorAll('[data-tab]').forEach(b=>{b.onclick=()=>selectTab(b.dataset.tab);});
$('position-filter').onchange=()=>{positionLimit=30;renderHistory(state.agents.find(a=>a.id===selected));};$('more-events').onclick=()=>{eventLimit+=50;renderHistory(state.agents.find(a=>a.id===selected));};$('more-positions').onclick=()=>{positionLimit+=50;renderHistory(state.agents.find(a=>a.id===selected));};
window.addEventListener('hashchange',route);window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
async function poll(){try{if(!saving){state=await request('/api/agents');route();}$('connection').textContent='● Panel conectado';}catch(error){$('connection').textContent='○ Sin conexión';if(!state)notice(error.message,true);}finally{setTimeout(poll,5000);}}poll();
