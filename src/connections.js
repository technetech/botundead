import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export function connectionUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('La API necesita una URL HTTPS válida'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Usa HTTPS, sin credenciales en la URL y con puerto 443');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Usa el dominio público de la API');
  // Tokens go in encrypted headers, never in URLs exposed to the browser/model.
  if ([...url.searchParams.keys()].some(k => /key|token|secret|password|auth/i.test(k))) throw new Error('Configura la clave como credencial, no en la URL');
  return url.toString();
}
export function publicAddress(address) {
  if (net.isIP(address) !== 4) return false; // Pin public IPv4, reject mapped and local IPv6.
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
}
export async function remoteJson(value, { method = 'GET', headers = {}, body, limit = 200000, timeout = 20000 } = {}) {
  const url = new URL(connectionUrl(value));
  const records = await dns.lookup(url.hostname, { all: true, family: 4 });
  if (!records.length || records.some(r => !publicAddress(r.address))) throw new Error('La API debe resolver a una dirección pública');
  const address = records[0].address;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { Accept: 'application/json', ...headers },
      // Pin the checked DNS address to prevent redirects/rebinding to internal services.
      lookup: (_host, options, callback) => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
    }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > limit) res.destroy(new Error('Respuesta de API demasiado grande')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`La API respondió HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('La API no devolvió JSON válido')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('La API agotó el tiempo de espera')), timeout);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function connectionsFor(agent, workspace) {
  const connections = agent.connections || [];
  const env = workspace.env;
  if (agent.connectionsConfigured || connections.some(c => c.kind === 'ai') || !(env.NVIDIA_API_KEY || env.LLM_API_KEY)) return connections;
  return [...connections, { id: 'environment-ai', kind: 'ai', name: env.NVIDIA_API_KEY ? 'NVIDIA' : 'Proveedor IA',
    url: env.NVIDIA_BASE_URL || env.LLM_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    model: env.NVIDIA_MODEL || env.LLM_MODEL || '', auth: 'bearer', envKey: env.NVIDIA_API_KEY ? 'NVIDIA_API_KEY' : 'LLM_API_KEY' }];
}
export function connectionKey(connection, workspace) {
  return (connection.envKey && workspace.env[connection.envKey]?.trim()) || (connection.secret ? workspace.decrypt(connection.secret) : '');
}
export function publicConnection(connection, workspace) {
  return { id: connection.id, kind: connection.kind, name: connection.name, url: connection.url, model: connection.model || '',
    auth: connection.auth, header: connection.header || '', envKey: connection.envKey || '',
    source: connection.envKey && workspace.env[connection.envKey] ? 'environment' : connection.secret ? 'panel' : null,
    configured: connection.auth === 'none' || Boolean((connection.envKey && workspace.env[connection.envKey]) || connection.secret) };
}
export function configureConnections(input, agent, workspace) {
  if (!Array.isArray(input) || input.length > 10) throw new Error('Puedes conectar hasta 10 APIs por agente');
  const previous = connectionsFor(agent, workspace);
  const result = input.map(c => {
    if (!c || !['ai','data'].includes(c.kind) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) throw new Error('Indica el nombre y tipo de cada API');
    const old = previous.find(p => p.id === c.id);
    const url = connectionUrl(c.url);
    if (c.kind === 'ai' && (typeof c.model !== 'string' || !c.model.trim() || c.model.length > 150)) throw new Error('Indica el modelo de tu proveedor de IA');
    if (!['none','bearer','header'].includes(c.auth) || (c.kind === 'ai' && c.auth !== 'bearer')) throw new Error('Autenticación de API inválida');
    if (c.auth === 'header' && (!/^[A-Za-z0-9-]{1,80}$/.test(c.header || '') || /^(host|cookie|connection|content-length|transfer-encoding|proxy-.*)$/i.test(c.header))) throw new Error('Encabezado de autenticación inválido');
    if (c.envKey && !/^[A-Z][A-Z0-9_]{0,99}$/.test(c.envKey)) throw new Error('Nombre de variable de entorno inválido');
    // Never repurpose a deployment secret as an external API credential.
    if (c.envKey && !/(?:API_KEY|API_TOKEN|ACCESS_TOKEN)$/.test(c.envKey)) throw new Error('Usa una variable terminada en API_KEY, API_TOKEN o ACCESS_TOKEN');
    if (c.apiKey !== undefined && (typeof c.apiKey !== 'string' || c.apiKey.length > 4096 || /[\r\n]/.test(c.apiKey))) throw new Error('Credencial de API inválida');
    if (old && new URL(old.url).origin !== new URL(url).origin && old.secret && !c.apiKey?.trim() && !c.removeKey) throw new Error('Al cambiar de dominio, introduce una nueva clave o quita la anterior');
    if (c.apiKey?.trim() && c.removeKey) throw new Error('Elige guardar o quitar la clave');
    const secret = c.removeKey ? undefined : c.apiKey?.trim() ? workspace.encrypt(c.apiKey.trim()) : old?.secret;
    return { id: old?.id || randomUUID(), kind: c.kind, name: c.name.trim(), url, model: c.kind === 'ai' ? c.model.trim() : '', auth: c.auth,
      header: c.auth === 'header' ? c.header : '', envKey: c.envKey || '', ...(secret ? { secret } : {}) };
  });
  if (result.filter(c => c.kind === 'ai').length > 1 || new Set(result.map(c => c.id)).size !== result.length) throw new Error('Selecciona un solo intérprete de IA y conexiones únicas');
  return result;
}
export function connectionHeaders(connection, workspace) {
  if (connection.auth === 'none') return {};
  const key = connectionKey(connection, workspace);
  if (!key) throw new Error(`Falta la credencial de ${connection.name}`);
  return connection.auth === 'header' ? { [connection.header]: key } : { Authorization: `Bearer ${key}` };
}
