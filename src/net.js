import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';

const USER_AGENT = 'commission-ai-slack';
const MAX_PROXY_REPLY_BYTES = 8192;
const MAX_STATUS_TEXT = 120;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const MAX_TIMER_MS = 2147483647;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const CROSS_ORIGIN_STRIPPED = ['authorization', 'cookie', 'proxy-authorization'];
const MANAGED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'accept-encoding']);
const SCHEMES = new Map([
  ['http:', { secure: false, tunnel: false, port: 80 }],
  ['ws:', { secure: false, tunnel: true, port: 80 }],
  ['https:', { secure: true, tunnel: true, port: 443 }],
  ['wss:', { secure: true, tunnel: true, port: 443 }],
]);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const STATUS_LINE = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const METHOD = /^[A-Z]{1,16}$/;

export class NetError extends Error {
  constructor(kind, text, written = false) {
    super(text);
    this.name = 'NetError';
    this.kind = kind;
    this.text = text;
    this.written = written;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function ignoreError() {
  return undefined;
}

export function isAbortSignal(value) {
  return (
    isObject(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  );
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseUrl(value) {
  const text = value instanceof URL ? value.href : value;
  if (typeof text !== 'string') return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function bareHost(hostname) {
  const lower = hostname.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function authorityHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function codeSuffix(error) {
  const code = isObject(error) ? error.code : undefined;
  return typeof code === 'string' && SAFE_CODE.test(code) ? ` (${code})` : '';
}

function isPrivateHost(host) {
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const v4 = IPV4.exec(host);
  if (v4 !== null) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first === 10 || first === 127) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    return first === 169 && second === 254;
  }
  if (host.includes(':')) {
    const group = Number.parseInt(host.split(':')[0] || '0', 16);
    if (Number.isNaN(group)) return false;
    return (group & 0xfe00) === 0xfc00 || (group & 0xffc0) === 0xfe80;
  }
  return false;
}

function matchesNoProxy(host, env) {
  const raw = [env.NO_PROXY, env.no_proxy].filter((value) => typeof value === 'string').join(',');
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (entry === '' || entry.includes('/')) continue;
    if (entry === '*') return true;
    const bare = entry.replace(/^\*\./, '').replace(/^\./, '');
    if (bare === '') continue;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

function firstSet(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function parseProxy(value) {
  const parsed = parseUrl(value.includes('://') ? value : `http://${value}`);
  if (parsed === null) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = bareHost(parsed.hostname);
  if (host === '') return null;
  const fallback = parsed.protocol === 'https:' ? 443 : 80;
  const port = parsed.port === '' ? fallback : Number(parsed.port);
  return { host, port };
}

export function proxyFor(url, env = process.env) {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  const source = isObject(env) ? env : {};
  const host = bareHost(parsed.hostname);
  if (host === '' || isPrivateHost(host) || matchesNoProxy(host, source)) return null;
  const scheme = SCHEMES.get(parsed.protocol);
  if (scheme === undefined) return null;
  const names = scheme.secure
    ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
    : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const value = firstSet(source, names);
  return value === null ? null : parseProxy(value);
}

function describeTarget(url) {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  const scheme = SCHEMES.get(parsed.protocol);
  if (scheme === undefined) return null;
  const host = bareHost(parsed.hostname);
  if (host === '') return null;
  const port = parsed.port === '' ? scheme.port : Number(parsed.port);
  return { url: parsed, host, port, secure: scheme.secure, tunnel: scheme.tunnel };
}

function safeStatusText(line) {
  return line.replace(/[^\x20-\x7e]/g, '').trim().slice(0, MAX_STATUS_TEXT);
}

function endsWithBlankLine(bytes) {
  const length = bytes.length;
  return (
    length >= 4 &&
    bytes[length - 4] === 13 &&
    bytes[length - 3] === 10 &&
    bytes[length - 2] === 13 &&
    bytes[length - 1] === 10
  );
}

function open(plan) {
  const { target, proxy, what, timeoutMs, tlsOptions, signal } = plan;
  const extra = isObject(tlsOptions) ? tlsOptions : {};
  const serverName = extra.servername ?? (net.isIP(target.host) === 0 ? target.host : undefined);
  return new Promise((resolve, reject) => {
    const sockets = [];
    const reply = [];
    let settled = false;
    let phase = proxy === null ? 'direct' : 'proxy-dial';
    let raw = null;

    const timer = setTimeout(() => fail(new NetError('unsent', `${what} didn't answer in time`)), timeoutMs);

    function detach(stream) {
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      stream.removeListener('readable', onReadable);
    }

    function finish() {
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      for (const stream of sockets) {
        detach(stream);
        stream.on('error', ignoreError);
      }
    }

    function fail(error) {
      if (settled) return;
      finish();
      for (const stream of sockets) stream.destroy();
      reject(error);
    }

    function succeed(stream) {
      if (settled) return;
      finish();
      resolve(stream);
    }

    function failure(error) {
      if (phase === 'proxy-dial' && proxy !== null) {
        return new NetError('unsent', `Can't reach the proxy ${proxy.host}:${proxy.port}`);
      }
      if (phase === 'proxy-reply') return new NetError('unsent', `The proxy closed the connection to ${what}`);
      return new NetError('unsent', `Can't reach ${what}${codeSuffix(error)}`);
    }

    function refused(detail) {
      return new NetError('unsent', `The proxy refused the connection to ${what} (${detail})`);
    }

    function onError(error) {
      fail(failure(error));
    }

    function onClose() {
      fail(failure(null));
    }

    function onAbort() {
      fail(new NetError('unsent', 'The connection was cancelled'));
    }

    function watch(stream) {
      sockets.push(stream);
      stream.on('error', onError);
      stream.on('close', onClose);
    }

    function wrapTls() {
      phase = 'tls';
      const secure = tls.connect({ ...extra, socket: raw, host: target.host, servername: serverName });
      watch(secure);
      secure.once('secureConnect', () => succeed(secure));
    }

    function onReply() {
      raw.removeListener('readable', onReadable);
      const text = Buffer.from(reply).toString('latin1');
      const line = text.split('\r\n')[0] ?? '';
      const match = STATUS_LINE.exec(line);
      if (match === null || match[1] !== '200') {
        fail(refused(safeStatusText(line) || 'no status'));
        return;
      }
      if (target.secure) {
        if (raw.readableLength > 0) {
          fail(refused('unexpected data'));
          return;
        }
        wrapTls();
        return;
      }
      succeed(raw);
    }

    function onReadable() {
      if (settled || phase !== 'proxy-reply') return;
      for (;;) {
        const chunk = raw.read(1);
        if (chunk === null) return;
        reply.push(chunk[0]);
        if (endsWithBlankLine(reply)) {
          onReply();
          return;
        }
        if (reply.length >= MAX_PROXY_REPLY_BYTES) {
          fail(refused('reply too large'));
          return;
        }
      }
    }

    function connectRequest() {
      const authority = `${authorityHost(target.host)}:${target.port}`;
      return `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`;
    }

    function dialProxy() {
      raw = net.connect({ host: proxy.host, port: proxy.port });
      watch(raw);
      raw.once('connect', () => {
        if (!target.tunnel) {
          succeed(raw);
          return;
        }
        phase = 'proxy-reply';
        raw.on('readable', onReadable);
        raw.write(connectRequest());
      });
    }

    function dialDirect() {
      if (target.secure) {
        raw = tls.connect({ ...extra, host: target.host, port: target.port, servername: serverName });
        watch(raw);
        raw.once('secureConnect', () => succeed(raw));
        return;
      }
      raw = net.connect({ host: target.host, port: target.port });
      watch(raw);
      raw.once('connect', () => succeed(raw));
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      if (proxy === null) dialDirect();
      else dialProxy();
    } catch (error) {
      fail(new NetError('unsent', `Can't reach ${what}${codeSuffix(error)}`));
    }
  });
}

export async function openStream(url, options) {
  const settings = isObject(options) ? options : {};
  const what = typeof settings.what === 'string' && settings.what !== '' ? settings.what : 'the server';
  const target = describeTarget(url);
  if (target === null) throw new NetError('unsent', 'The address is not valid');
  return open({
    target,
    proxy: proxyFor(target.url, settings.env),
    what,
    timeoutMs: Math.min(positive(settings.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS), MAX_TIMER_MS),
    tlsOptions: settings.tlsOptions,
    signal: isAbortSignal(settings.signal) ? settings.signal : undefined,
  });
}

function headerValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((part) => typeof part === 'string');
    return parts.length === 0 ? null : parts.join(', ');
  }
  return null;
}

function normalizeHeaders(input) {
  const map = new Map();
  if (input === undefined || input === null) return map;
  if (typeof input !== 'object') return null;
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (name === '__proto__' || MANAGED_HEADERS.has(name)) continue;
    const value = headerValue(rawValue);
    if (value !== null) map.set(name, value);
  }
  return map;
}

function toPayload(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return false;
}

function normalizeRedirect(value) {
  if (!isObject(value)) return null;
  const max = typeof value.max === 'number' && Number.isFinite(value.max) && value.max > 0 ? Math.floor(value.max) : 0;
  const allow = typeof value.allow === 'function' ? value.allow : () => false;
  return { max, allow };
}

function outgoingHeaders(headers, url, payload, method) {
  const out = {};
  for (const [name, value] of headers) out[name] = value;
  if (out.host === undefined) out.host = url.host;
  if (out['user-agent'] === undefined) out['user-agent'] = USER_AGENT;
  out['accept-encoding'] = 'identity';
  out.connection = 'close';
  if (payload !== null) out['content-length'] = String(payload.length);
  else if (BODY_METHODS.has(method)) out['content-length'] = '0';
  return out;
}

function collectHeaders(rawHeaders) {
  const out = {};
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    if (name === '__proto__') continue;
    const value = String(rawHeaders[index + 1]);
    out[name] = Object.hasOwn(out, name) ? `${out[name]}, ${value}` : value;
  }
  return out;
}

function classifyError(error, written) {
  if (error instanceof NetError) return error;
  const code = isObject(error) && typeof error.code === 'string' ? error.code : '';
  if (code.startsWith('HPE_')) return new NetError('unsure', 'The server sent a response that could not be read');
  return new NetError(written ? 'unsure' : 'unsent', `The connection to the server was lost${codeSuffix(error)}`);
}

function attempt(plan) {
  const { url, method, headers, payload, deadlineAt, maxBytes, connectTimeoutMs, env, tlsOptions, signal } = plan;
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    const state = { written: false, settled: false, req: null, res: null, socket: null };
    const chunks = [];
    let total = 0;

    const remaining = Math.min(Math.max(deadlineAt - Date.now(), 1), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      fail(new NetError(state.written ? 'unsure' : 'unsent', 'The request timed out'));
    }, remaining);

    function settle() {
      state.settled = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onCancel);
    }

    function onCancel() {
      fail(new NetError(state.written ? 'unsure' : 'unsent', 'The request was cancelled'));
    }

    function release() {
      abort.abort();
      if (state.res !== null) state.res.destroy();
      if (state.req !== null) state.req.destroy();
      if (state.socket !== null) state.socket.destroy();
    }

    function fail(error) {
      if (state.settled) return;
      settle();
      error.written = state.written;
      release();
      reject(error);
    }

    function succeed(res) {
      if (state.settled) return;
      settle();
      const result = { status: res.statusCode ?? 0, headers: collectHeaders(res.rawHeaders), body: Buffer.concat(chunks, total) };
      release();
      resolve(result);
    }

    function tooLarge() {
      fail(new NetError('too_large', `The response is larger than ${maxBytes} bytes`, true));
    }

    function onResponse(res) {
      state.res = res;
      res.on('error', (error) => fail(classifyError(error, state.written)));
      const bodyless = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
      const declared = Number(res.headers['content-length']);
      if (maxBytes !== undefined && !bodyless && Number.isFinite(declared) && declared > maxBytes) {
        tooLarge();
        return;
      }
      res.on('data', (chunk) => {
        total += chunk.length;
        if (maxBytes !== undefined && total > maxBytes) {
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => succeed(res));
      res.on('close', () => {
        if (!res.complete) fail(new NetError('unsure', 'The connection closed before the response finished'));
      });
    }

    if (signal !== undefined) signal.addEventListener('abort', onCancel, { once: true });
    const secure = url.protocol === 'https:';
    const viaProxy = !secure && proxyFor(url, env) !== null;
    const path = viaProxy ? `${url.origin}${url.pathname}${url.search}` : `${url.pathname}${url.search}`;
    let req;
    try {
      req = http.request({
        method,
        path,
        headers: outgoingHeaders(headers, url, payload, method),
        host: bareHost(url.hostname),
        port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
        createConnection: (_options, callback) => {
          openStream(url, { env, connectTimeoutMs, tlsOptions, signal: abort.signal }).then(
            (socket) => {
              if (state.settled) {
                socket.destroy();
                return;
              }
              state.socket = socket;
              callback(null, socket);
            },
            (error) => callback(error instanceof NetError ? error : new NetError('unsent', "Can't reach the server")),
          );
          return undefined;
        },
      });
    } catch {
      fail(new NetError('unsent', 'The request could not be built'));
      return;
    }
    state.req = req;
    req.on('error', (error) => fail(classifyError(error, state.written)));
    req.on('finish', () => {
      state.written = true;
    });
    req.on('response', onResponse);
    req.on('close', () => {
      if (state.res === null) {
        fail(new NetError(state.written ? 'unsure' : 'unsent', 'The connection closed before the server answered'));
      }
    });
    if (payload === null) req.end();
    else req.end(payload);
  });
}

function redirectTarget(response, current, redirect, hops) {
  if (redirect === null || !REDIRECT_STATUSES.has(response.status)) return null;
  if (hops >= redirect.max) return null;
  const location = response.headers.location;
  if (typeof location !== 'string' || location.trim() === '') return null;
  let next;
  try {
    next = new URL(location.trim(), current);
  } catch {
    return null;
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
  let allowed = false;
  try {
    allowed = Boolean(redirect.allow(new URL(next.href)));
  } catch {
    allowed = false;
  }
  return allowed ? next : null;
}

function sameOrigin(left, right) {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

export async function request(options) {
  const input = isObject(options) ? options : {};
  const first = parseUrl(input.url);
  if (first === null || (first.protocol !== 'http:' && first.protocol !== 'https:')) {
    throw new NetError('unsent', 'The request address is not valid');
  }
  const rawMethod = typeof input.method === 'string' && input.method !== '' ? input.method.toUpperCase() : 'GET';
  let headers = normalizeHeaders(input.headers);
  let payload = toPayload(input.body);
  if (!METHOD.test(rawMethod) || headers === null || payload === false) {
    throw new NetError('unsent', 'The request could not be built');
  }
  let method = rawMethod;
  const timeoutMs = Math.min(positive(input.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS), MAX_TIMER_MS);
  const connectTimeoutMs = positive(input.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  const maxBytes = typeof input.maxBytes === 'number' && input.maxBytes >= 0 ? input.maxBytes : undefined;
  const redirect = normalizeRedirect(input.redirect);
  const signal = isAbortSignal(input.signal) ? input.signal : undefined;
  const deadlineAt = Date.now() + timeoutMs;
  let current = first;
  let hops = 0;
  for (;;) {
    if (signal !== undefined && signal.aborted) throw new NetError('unsent', 'The request was cancelled');
    const response = await attempt({
      url: current,
      method,
      headers,
      payload,
      deadlineAt,
      maxBytes,
      connectTimeoutMs,
      env: input.env,
      tlsOptions: input.tlsOptions,
      signal,
    });
    const next = redirectTarget(response, current, redirect, hops);
    if (next === null) return { status: response.status, headers: response.headers, url: current, body: response.body };
    hops += 1;
    const carried = new Map(headers);
    if (response.status === 301 || response.status === 302 || response.status === 303) {
      if (method !== 'HEAD') method = 'GET';
      payload = null;
      carried.delete('content-type');
    }
    if (!sameOrigin(current, next)) {
      for (const name of CROSS_ORIGIN_STRIPPED) carried.delete(name);
    }
    headers = carried;
    current = next;
  }
}
