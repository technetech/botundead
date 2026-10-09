const BASE = 'https://undeadwallet.com/api/trading/agent';

export class ApiError extends Error {
  constructor(message, uncertain = false) {
    super(message);
    this.uncertain = uncertain;
  }
}

export class Api {
  constructor(key, fetchImpl = fetch) {
    this.key = key;
    this.fetch = fetchImpl;
  }

  async request(path, body) {
    const mutation = body !== undefined;
    let response;
    let data;
    try {
      response = await this.fetch(`${BASE}${path}`, {
        method: mutation ? 'POST' : 'GET',
        headers: { 'X-Api-Key': this.key, ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
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
  account() { return this.request('/account'); }
  open(body) { return this.request('/open', body); }
  close(body) { return this.request('/close', body); }
}
