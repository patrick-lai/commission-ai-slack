import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startWsServer } from './ws-server.js';

export const GOOD_BOT = 'xoxb-test-bot-token-0000000000000000';
export const GOOD_APP = 'xapp-test-app-token-0000000000000000';
export const APPROVED_SCOPES = 'app_mentions:read,channels:history,channels:read,chat:write,commands,groups:history,groups:read,im:history,im:read,im:write,users:read,users:read.email,files:write';

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function decode(request, body) {
  const type = request.headers['content-type'] ?? '';
  const text = body.toString('utf8');
  if (type.startsWith('application/json')) {
    return JSON.parse(text);
  }
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

export async function startFakeSlack() {
  const events = new EventEmitter();
  const calls = [];
  const uploads = [];
  const handlers = new Map();
  const files = new Map();
  const acks = [];
  let socket = null;
  let socketCount = 0;
  let base = '';
  const ws = await startWsServer({
    onConnection(connection) {
      socket = connection;
      socketCount += 1;
      events.emit('socket', connection);
      connection.on('message', (text) => {
        const frame = JSON.parse(text);
        acks.push(frame);
        events.emit('ack', frame);
      });
      if (!fake.silent) {
        connection.sendText(JSON.stringify({ type: 'hello', num_connections: 1 }));
      }
    },
  });
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url, 'http://fake');
    const authorization = request.headers.authorization ?? '';
    if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
      const file = files.get(url.pathname.slice('/files/'.length));
      calls.push({ method: `GET ${url.pathname}`, authorization });
      if (file === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(file.status ?? 200, { 'content-type': file.type ?? 'application/octet-stream', ...(file.headers ?? {}) });
      response.end(file.body);
      return;
    }
    if (request.method === 'POST' && url.pathname.startsWith('/upload/')) {
      uploads.push({ id: url.pathname.slice('/upload/'.length), bytes: body, type: request.headers['content-type'] });
      const handler = handlers.get('upload');
      const answer = handler === undefined ? { status: 200, body: 'OK' } : handler({ id: url.pathname.slice('/upload/'.length), bytes: body });
      response.writeHead(answer.status ?? 200).end(answer.body ?? '');
      return;
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      const method = url.pathname.slice('/api/'.length);
      const payload = body.length === 0 ? null : decode(request, body);
      const call = { method, authorization, payload, contentType: request.headers['content-type'] ?? null };
      calls.push(call);
      events.emit('call', call);
      const handler = handlers.get(method);
      const answer = handler === undefined ? defaults(method, payload) : await handler(call);
      const headers = { 'content-type': 'application/json', ...(answer.headers ?? {}) };
      response.writeHead(answer.status ?? 200, headers);
      response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  function defaults(method, payload) {
    switch (method) {
      case 'auth.test':
        return { body: { ok: true, user_id: 'UBOT0001', user: 'commissionbot', team_id: 'T001', team: 'Acme' }, headers: { 'x-oauth-scopes': APPROVED_SCOPES } };
      case 'apps.connections.open':
        return { body: { ok: true, url: ws.url } };
      case 'conversations.info':
        return { body: { ok: true, channel: { id: payload.channel, name: 'feedback', is_private: false, is_member: true } } };
      case 'conversations.join':
        return { body: { ok: true } };
      case 'conversations.open':
        return { body: { ok: true, channel: { id: 'D0DIRECTMSG' } } };
      case 'users.conversations':
        return { body: { ok: true, channels: [{ id: 'C0JOINED01', name: 'joined', is_private: false }] } };
      case 'conversations.list':
        return { body: { ok: true, channels: [{ id: 'C0LISTED01', name: 'listed', is_private: false, is_member: false }] } };
      case 'users.info':
        return { body: { ok: true, user: { name: 'dana', profile: { display_name: 'Dana Lee' } } } };
      case 'chat.postMessage':
        return { body: { ok: true, ts: '1712345999.000100' } };
      case 'files.getUploadURLExternal':
        return { body: { ok: true, file_id: `F${uploads.length + 100}`, upload_url: `${base}/upload/${payload.filename}` } };
      case 'files.completeUploadExternal':
        return { body: { ok: true, files: payload.files } };
      case 'files.info':
        return { body: { ok: false, error: 'file_not_found' } };
      default:
        return { body: { ok: false, error: 'unknown_method' } };
    }
  }

  const fake = {
    base,
    apiBase: `${base}/api/`,
    calls,
    uploads,
    acks,
    events,
    files,
    silent: false,
    wsUrl: ws.url,
    handle(method, handler) {
      handlers.set(method, handler);
    },
    callsTo(method) {
      return calls.filter((call) => call.method === method);
    },
    get socket() {
      return socket;
    },
    get socketCount() {
      return socketCount;
    },
    envelope(payload, id = `env-${acks.length + calls.length}`) {
      return { type: 'events_api', envelope_id: id, payload, accepts_response_payload: false };
    },
    send(frame) {
      return socket.sendText(JSON.stringify(frame));
    },
    nextAck() {
      return new Promise((resolve) => events.once('ack', resolve));
    },
    nextCall(method) {
      return new Promise((resolve) => {
        const check = (call) => {
          if (call.method === method) {
            events.off('call', check);
            resolve(call);
          }
        };
        events.on('call', check);
      });
    },
    nextSocket() {
      return new Promise((resolve) => events.once('socket', resolve));
    },
    async close() {
      await ws.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}
