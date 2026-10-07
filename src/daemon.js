import { NetError, request } from './net.js';

export const TOKEN_HEADER = 'x-commission-connector-token';
export const PROTOCOL = 1;
export const LONG_POLL_MS = 25000;
const API = '/v1/connectors/slack';
const CALL_TIMEOUT_MS = 30000;
const POLL_MARGIN_MS = 15000;
const MEDIA_TIMEOUT_MS = 120000;
const FATAL_STATUSES = [401, 403];
const FATAL_CODES = ['connector.protocol', 'connector.already_attached'];

export class DaemonError extends Error {
  constructor({ status, code, message }) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.code = code;
    this.fatal = FATAL_STATUSES.includes(status) || FATAL_CODES.includes(code);
  }
}

export function loopbackEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '') {
    return null;
  }
  return url;
}

function parseBody(response) {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    return null;
  }
}

function failure(response) {
  const body = parseBody(response);
  const code = typeof body?.code === 'string' ? body.code : 'connector.unexpected_response';
  const message = typeof body?.message === 'string' ? body.message : `CommissionAI answered HTTP ${response.status}`;
  return new DaemonError({ status: response.status, code, message });
}

export class Daemon {
  constructor({ endpoint, token, send = request }) {
    this.endpoint = endpoint;
    this.token = token;
    this.send = send;
  }

  async exchange(method, path, { json, body, headers = {}, timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
    const merged = { [TOKEN_HEADER]: this.token, accept: 'application/json', ...headers };
    let payload = body;
    if (json !== undefined) {
      merged['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    try {
      return await this.send({ url: new URL(path, this.endpoint), method, headers: merged, body: payload, timeoutMs, connectTimeoutMs: 5000, redirect: null, env: {}, signal });
    } catch (error) {
      if (error instanceof NetError) {
        throw new DaemonError({ status: 0, code: 'connector.daemon_unreachable', message: 'CommissionAI could not be reached' });
      }
      throw error;
    }
  }

  async json(method, path, options) {
    const response = await this.exchange(method, path, options);
    if (response.status < 200 || response.status > 299) {
      throw failure(response);
    }
    const body = parseBody(response);
    if (body === null) {
      throw new DaemonError({ status: response.status, code: 'connector.unexpected_response', message: 'CommissionAI answered with something unreadable' });
    }
    return body;
  }

  session(generation, version, signal) {
    return this.json('POST', `${API}/session`, { json: { protocol: PROTOCOL, version, generation, wait_ms: LONG_POLL_MS }, timeoutMs: LONG_POLL_MS + POLL_MARGIN_MS, signal });
  }

  status(update) {
    return this.json('PUT', `${API}/status`, { json: update });
  }

  inbound(event) {
    return this.json('POST', `${API}/inbound`, { json: event });
  }

  async claim(signal) {
    const body = await this.json('POST', `${API}/outbox/claim`, { json: { wait_ms: LONG_POLL_MS }, timeoutMs: LONG_POLL_MS + POLL_MARGIN_MS, signal });
    return Array.isArray(body.rows) ? body.rows : [];
  }

  result(id, outcome) {
    return this.json('POST', `${API}/outbox/${encodeURIComponent(id)}/result`, { json: outcome });
  }

  async nextCommand(signal) {
    const body = await this.json('POST', `${API}/commands/next`, { json: { wait_ms: LONG_POLL_MS }, timeoutMs: LONG_POLL_MS + POLL_MARGIN_MS, signal });
    return typeof body.command === 'object' && body.command !== null ? body.command : null;
  }

  commandResult(id, result) {
    return this.json('POST', `${API}/commands/${encodeURIComponent(id)}/result`, { json: result });
  }

  async media(sha) {
    let response;
    try {
      response = await this.exchange('GET', `${API}/media/${encodeURIComponent(sha)}`, { timeoutMs: MEDIA_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof DaemonError) {
        return { state: 'error' };
      }
      throw error;
    }
    if (response.status === 404) {
      return { state: 'missing' };
    }
    if (response.status < 200 || response.status > 299) {
      return { state: 'error' };
    }
    return { state: 'found', bytes: response.body };
  }

  async stageMedia(name, mime, bytes) {
    let response;
    try {
      response = await this.exchange('POST', `${API}/media?name=${encodeURIComponent(name)}`, { body: bytes, headers: { 'content-type': mime === '' ? 'application/octet-stream' : mime }, timeoutMs: MEDIA_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof DaemonError) {
        return { code: error.code };
      }
      throw error;
    }
    const body = parseBody(response);
    if (response.status >= 200 && response.status <= 299 && typeof body?.sha === 'string') {
      return { sha: body.sha };
    }
    return { code: typeof body?.code === 'string' ? body.code : 'connector.unexpected_response' };
  }
}
