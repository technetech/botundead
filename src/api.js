const BASE = 'https://undeadwallet.com/api/trading/agent';
let documentationCache;

export class ApiError extends Error {
  constructor(message, uncertain = false) {
    super(message);
    this.uncertain = uncertain;
  }
}

export class Api {
  constructor(key, fetchImpl = fetch, botId) {
    if (botId !== undefined && (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(botId))) {
      throw new Error('Identificador del bot invalido; revisar DATA_DIR/bot-id sin cambiar la identidad de un bot activo');
    }
    this.key = key;
    this.fetch = fetchImpl;
    this.botId = botId;
  }

  async request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const mutation = body !== undefined;
    let response;
    let data;
    try {
      response = await this.fetch(`${BASE}${path}`, {
        method,
        headers: { 'X-Asset-Key': this.key, ...(this.botId ? { 'X-Bot-Id': this.botId } : {}), ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
        ...(mutation ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      data = await response.json();
    } catch (error) {
      const detail = response
        ? `HTTP ${response.status}, respuesta no JSON`
        : `${error?.name === 'TimeoutError' ? 'timeout de 15 segundos' : 'fallo de conexion'} (${String(error?.cause?.code || error?.name || 'Error')})`;
      throw new ApiError(`${path}: ${detail}`, mutation);
    }
    if (!response.ok || data?.ok !== true) {
      // Solo los rechazos explicitos 4xx/503 se consideran definitivos.
      const rejected = data?.ok === false && (response.status < 500 || response.status === 503);
      const reason = typeof data?.reason === 'string' ? data.reason.replaceAll(this.key, '[REDACTED]').slice(0, 200) : 'respuesta_invalida';
      throw new ApiError(`${path}: HTTP ${response.status}, ${reason}`, mutation && !rejected);
    }
    return data;
  }

  async learn() {
    const data = await this.request('/learn');
    if (typeof data.learn_version !== 'string' || !data.learn_version.trim()) {
      throw new ApiError('/learn: falta learn_version; contrato inesperado');
    }
    return data;
  }
  assets() { return this.request('/assets'); }
  async documentation() {
    if (documentationCache && documentationCache.expires > Date.now()) return documentationCache.data;
    const response = await this.fetch(`${BASE}/docsapi`, { headers: this.botId ? { 'X-Bot-Id': this.botId } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new ApiError('No se pudo consultar el contrato de Undeadwallet');
    const doc = await response.json();
    const open = doc.paths?.['/open']?.post?.requestBody?.content?.['application/json']?.schema;
    const close = doc.paths?.['/close']?.post?.requestBody?.content?.['application/json']?.schema;
    if (!open?.properties?.size_usd || !close?.properties?.id) throw new ApiError('Contrato de Undeadwallet no compatible; revisar antes de operar');
    const data = { version: doc.info?.version, open, close };
    documentationCache = { data, expires: Date.now() + 3600000 }; return data;
  }
  async version() {
    const data = await this.request('/version');
    if (typeof data.version !== 'string' || !data.version.trim()
        || typeof data.learn_version !== 'string' || !data.learn_version.trim()
        || typeof data.must_relearn !== 'boolean') {
      throw new ApiError('/version: contrato inesperado');
    }
    return data;
  }
  heartbeat() { return this.request('/heartbeat', undefined, 'POST'); }
  account() { return this.request('/account'); }
  open(body) { return this.request('/open', body); }
  close(body) { return this.request('/close', body); }
}

// Job independiente de la operativa; nunca envia ni reintenta ordenes.
export class VersionMonitor {
  constructor(api, log = () => {}, now = () => Date.now()) {
    this.api = api;
    this.log = log;
    this.now = now;
    this.nextRead = 0;
    this.pending = null;
    this.learnVersion = null;
  }

  refresh() {
    if (this.pending || this.now() < this.nextRead) return;
    this.nextRead = this.now() + 15 * 60000;
    this.pending = (async () => {
      try {
        const data = await this.api.version();
        if (data.must_relearn) await this.api.learn();
        if (this.learnVersion !== data.learn_version || data.must_relearn) {
          this.log('api_version', { version: data.version, learnVersion: data.learn_version, relearned: data.must_relearn });
        }
        this.learnVersion = data.learn_version;
      } catch (error) {
        this.log('api_version_error', { reason: error.message });
      } finally { this.pending = null; }
    })();
  }
}

// El latido no envia ordenes: un fallo no debe bloquear cierres ni pausar el bot.
export class Heartbeat {
  constructor(api, log = () => {}, now = () => Date.now()) {
    this.api = api;
    this.log = log;
    this.now = now;
    this.nextBeat = 0;
  }

  async tick() {
    if (this.now() < this.nextBeat) return;
    this.nextBeat = this.now() + 60000;
    try {
      await this.api.heartbeat();
      this.log('api_heartbeat', { live: true });
    } catch (error) {
      this.log('api_heartbeat_error', { reason: error.message });
    }
  }
}
