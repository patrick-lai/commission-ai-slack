import { CallError, describe, isAuth } from './errors.js';
import { redact } from './redact.js';
import { scopeLocked } from './scopes.js';
import { connect } from './ws.js';

export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
export const IDLE_TIMEOUT_MS = 75000;
export const PING_EVERY_MS = 30000;
export const SOCKET_FRAME = 1024 * 1024;
export const CONNECT_BUDGET_MS = 15000;
export const QUICK_MS = 5000;
export const QUEUE_LIMIT = 500;

export function wentQuiet(sinceLastFrameMs, idleMs) {
  return sinceLastFrameMs > idleMs;
}

export function socketError(text, url) {
  const stripped = url === '' ? text : text.replaceAll(url, '');
  const at = stripped.indexOf(': ');
  if (at > 0) {
    const code = stripped.slice(0, at);
    if (code.includes('.') && !code.includes(' ')) {
      return stripped.slice(at + 2);
    }
  }
  return stripped;
}

function fail(phase, detail) {
  return { ok: false, phase, detail };
}

function failed(method, error) {
  return { ready: false, quick: true, outcome: fail(isAuth(error) ? 'failing' : 'offline', describe(method, error)) };
}

export async function socketSession({ slack, tokens, hooks, signal, settings = {} }) {
  const idleMs = settings.idleMs ?? IDLE_TIMEOUT_MS;
  const pingMs = settings.pingMs ?? PING_EVERY_MS;
  const now = settings.now ?? Date.now;
  let identity;
  try {
    identity = await slack.authTest(tokens.bot_token);
  } catch (error) {
    if (error instanceof CallError) {
      return failed('auth.test', error.detail);
    }
    throw error;
  }
  if (identity.unapproved.length > 0) {
    return { ready: false, quick: true, outcome: fail('failing', scopeLocked(identity.unapproved)) };
  }
  await hooks.identity(identity);
  let url;
  try {
    url = await slack.connectionsOpen(tokens.app_token);
  } catch (error) {
    if (error instanceof CallError) {
      return failed('apps.connections.open', error.detail);
    }
    throw error;
  }
  let socket;
  try {
    socket = await connect(url, { env: slack.env, connectTimeoutMs: settings.connectMs ?? CONNECT_BUDGET_MS, maxMessageBytes: SOCKET_FRAME, what: 'the Slack service', signal });
  } catch (error) {
    if (signal?.aborted) {
      return { ready: false, quick: false, outcome: { ok: true } };
    }
    const text = typeof error?.text === 'string' ? error.text : 'the connection failed';
    if (text.endsWith("didn't answer in time")) {
      return { ready: false, quick: true, outcome: fail('offline', "Slack didn't answer in time") };
    }
    return { ready: false, quick: true, outcome: fail('offline', `Can't open the Slack connection (${redact(socketError(text, url), 200)})`) };
  }
  return pump({ socket, identity, hooks, signal, idleMs, pingMs, now });
}

function pump({ socket, hooks, signal, idleMs, pingMs, now }) {
  const started = now();
  let ready = false;
  let lastRx = now();
  let queued = 0;
  let chain = Promise.resolve();
  let finished = false;
  let finish = () => {};
  const done = new Promise((resolve) => {
    finish = (outcome) => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(ticker);
      signal?.removeEventListener('abort', onAbort);
      socket.terminate();
      resolve({ ready, quick: now() - started < QUICK_MS, outcome });
    };
  });
  const dropped = () => finish(fail('offline', 'The Slack connection dropped'));
  const ticker = setInterval(() => {
    if (wentQuiet(now() - lastRx, idleMs)) {
      finish(fail('offline', 'The Slack connection went quiet'));
    } else if (!socket.sendPing()) {
      dropped();
    }
  }, pingMs);
  const onAbort = () => finish({ ok: true });
  signal?.addEventListener('abort', onAbort, { once: true });
  const handle = async (text) => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) {
      return;
    }
    if (frame.type === 'hello') {
      ready = true;
      await hooks.online();
      return;
    }
    if (frame.type === 'disconnect') {
      finish({ ok: true });
      return;
    }
    if (typeof frame.type !== 'string' || typeof frame.envelope_id !== 'string') {
      return;
    }
    const accepted = frame.type === 'events_api' ? await hooks.receive(frame.payload ?? null) : true;
    if (accepted && !finished && !socket.sendText(JSON.stringify({ envelope_id: frame.envelope_id }))) {
      dropped();
    }
  };
  socket.on('message', (text) => {
    lastRx = now();
    if (queued >= QUEUE_LIMIT) {
      finish(fail('offline', 'Too many Slack events are waiting to be handled'));
      return;
    }
    queued += 1;
    chain = chain
      .then(() => handle(text))
      .catch(() => finish(fail('offline', 'The Slack connector could not handle an event')))
      .finally(() => {
        queued -= 1;
      });
  });
  socket.on('ping', (data) => {
    lastRx = now();
    if (!socket.sendPong(data)) {
      dropped();
    }
  });
  socket.on('pong', () => {
    lastRx = now();
  });
  socket.on('error', (error) => {
    finish(fail('offline', `The Slack connection broke (${redact(typeof error?.text === 'string' ? error.text : 'unknown error', 120)})`));
  });
  socket.on('close', () => finish({ ok: true }));
  return done;
}

export async function runSocketMode({ slack, tokens, hooks, signal, settings = {} }) {
  const backoff = settings.backoffMs ?? BACKOFF_MS;
  const sleep = settings.sleep ?? sleepFor;
  let attempt = 0;
  while (!signal.aborted) {
    await hooks.status('connecting', null);
    const ended = await socketSession({ slack, tokens, hooks, signal, settings });
    if (signal.aborted) {
      break;
    }
    if (ended.ready) {
      attempt = 0;
    }
    let wait = 0;
    if (ended.outcome.ok) {
      await hooks.status('connecting', null);
      if (ended.quick) {
        wait = backoff[Math.min(attempt, backoff.length - 1)];
        attempt += 1;
      }
    } else {
      await hooks.status(ended.outcome.phase, ended.outcome.detail);
      wait = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
    }
    if (wait > 0) {
      await sleep(wait, signal);
    }
  }
}

export function sleepFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
