import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const TOKEN_HEADER = 'x-commission-connector-token';

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function shape(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shape(value[0])];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  }
  return value === null ? 'null' : typeof value;
}

export function sameShape(left, right) {
  return JSON.stringify(shape(left)) === JSON.stringify(shape(right));
}

export async function startFakeDaemon({ token = 'cmc_testtoken', pollMs = 20 } = {}) {
  const events = new EventEmitter();
  const state = {
    generation: 1,
    credentials: null,
    outbox: [],
    claimed: new Map(),
    commands: [],
    answers: new Map(),
    inbound: [],
    inboundReply: () => ({ status: 200, body: { accepted: true, notice: null } }),
    statuses: [],
    results: [],
    sessions: [],
    media: new Map(),
    staged: [],
    stageReply: null,
    requests: [],
    refuse: new Map(),
  };

  function wait(predicate) {
    return new Promise((resolve) => {
      if (predicate()) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, pollMs);
      function finish() {
        clearTimeout(timer);
        events.off('change', check);
        resolve();
      }
      function check() {
        if (predicate()) {
          finish();
        }
      }
      events.on('change', check);
    });
  }

  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url, 'http://fake');
    const path = url.pathname;
    state.requests.push({ method: request.method, path, token: request.headers[TOKEN_HEADER] ?? null, hasOrigin: 'origin' in request.headers });
    const reply = (status, payload, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    };
    const refusal = state.refuse.get(path);
    if (request.headers[TOKEN_HEADER] !== token) {
      reply(401, { code: 'connector.token_invalid', message: 'CommissionAI does not recognise this connector token.' });
      return;
    }
    if (refusal !== undefined) {
      reply(refusal.status, { code: refusal.code, message: refusal.message ?? 'refused' });
      return;
    }
    const json = () => (body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
    if (path === '/v1/connectors/slack/session' && request.method === 'POST') {
      const request_ = json();
      state.sessions.push(request_);
      await wait(() => request_.generation !== state.generation);
      reply(200, { protocol: 1, generation: state.generation, credentials: state.credentials });
      return;
    }
    if (path === '/v1/connectors/slack/status' && request.method === 'PUT') {
      const status = json();
      state.statuses.push(status);
      events.emit('status', status);
      reply(200, { ok: true });
      return;
    }
    if (path === '/v1/connectors/slack/inbound' && request.method === 'POST') {
      const inbound = json();
      state.inbound.push(inbound);
      events.emit('inbound', inbound);
      const answer = state.inboundReply(inbound);
      reply(answer.status, answer.body);
      return;
    }
    if (path === '/v1/connectors/slack/outbox/claim' && request.method === 'POST') {
      await wait(() => state.outbox.length > 0);
      const rows = state.outbox.splice(0, state.outbox.length);
      for (const row of rows) {
        state.claimed.set(row.id, row);
      }
      reply(200, { rows });
      return;
    }
    const resultMatch = /^\/v1\/connectors\/slack\/outbox\/([^/]+)\/result$/.exec(path);
    if (resultMatch && request.method === 'POST') {
      const id = decodeURIComponent(resultMatch[1]);
      const outcome = json();
      state.results.push({ id, outcome });
      state.claimed.delete(id);
      events.emit('result', { id, outcome });
      reply(200, { ok: true });
      return;
    }
    if (path === '/v1/connectors/slack/commands/next' && request.method === 'POST') {
      await wait(() => state.commands.length > 0);
      const command = state.commands.shift() ?? null;
      reply(200, { command });
      return;
    }
    const answerMatch = /^\/v1\/connectors\/slack\/commands\/([^/]+)\/result$/.exec(path);
    if (answerMatch && request.method === 'POST') {
      const id = decodeURIComponent(answerMatch[1]);
      const answer = json();
      state.answers.set(id, answer);
      events.emit('answer', { id, answer });
      reply(200, { ok: true });
      return;
    }
    const mediaMatch = /^\/v1\/connectors\/slack\/media\/([^/]+)$/.exec(path);
    if (mediaMatch && request.method === 'GET') {
      const file = state.media.get(decodeURIComponent(mediaMatch[1]));
      if (file === undefined) {
        reply(404, { code: 'hub.media_not_found', message: 'That file is not here' });
        return;
      }
      reply(200, file, { 'content-type': 'application/octet-stream' });
      return;
    }
    if (path === '/v1/connectors/slack/media' && request.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'file';
      if (state.stageReply !== null) {
        reply(state.stageReply.status, state.stageReply.body);
        return;
      }
      const sha = crypto.createHash('sha256').update(body).digest('hex');
      state.staged.push({ name, mime: request.headers['content-type'] ?? '', bytes: body, sha });
      reply(200, { sha, name, mime: request.headers['content-type'] ?? '', size: body.length, width: null, height: null, duration_ms: null, frames: [] });
      return;
    }
    reply(404, { code: 'request.unsupported_route', message: 'API route or method is unsupported' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint,
    token,
    state,
    events,
    setCredentials(credentials) {
      state.credentials = credentials;
      state.generation += 1;
      events.emit('change');
    },
    pushOutbox(row) {
      state.outbox.push(row);
      events.emit('change');
    },
    pushCommand(call) {
      const id = `cmd-${state.commands.length + state.answers.size + 1}-${crypto.randomUUID()}`;
      state.commands.push({ id, call });
      events.emit('change');
      return new Promise((resolve) => {
        const check = ({ id: answered, answer }) => {
          if (answered === id) {
            events.off('answer', check);
            resolve(answer);
          }
        };
        events.on('answer', check);
      });
    },
    once(name) {
      return new Promise((resolve) => events.once(name, resolve));
    },
    nextWhere(name, predicate) {
      return new Promise((resolve) => {
        const check = (value) => {
          if (predicate(value)) {
            events.off(name, check);
            resolve(value);
          }
        };
        events.on(name, check);
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
