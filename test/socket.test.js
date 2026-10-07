import assert from 'node:assert/strict';
import test from 'node:test';
import { Slack } from '../src/slack.js';
import { BACKOFF_MS, runSocketMode, socketSession } from '../src/socket.js';
import { GOOD_APP, GOOD_BOT, startFakeSlack } from './helpers/fake-slack.js';

const tokens = { bot_token: GOOD_BOT, app_token: GOOD_APP };
const message = { event_id: 'Ev1', event: { type: 'message', user: 'U123', channel: 'C0FEEDBK', text: 'hi', ts: '1712345678.000100' } };

function recorder(accept = () => true) {
  const log = [];
  const hooks = {
    log,
    identity: async (identity) => {
      log.push(['identity', identity.user_id]);
    },
    online: async () => {
      log.push(['online']);
    },
    status: async (phase, detail) => {
      log.push(['status', phase, detail]);
    },
    receive: async (payload) => {
      log.push(['receive', payload.event_id]);
      return accept(payload);
    },
  };
  return hooks;
}

async function withSlack(run) {
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, env: {} });
  try {
    await run(fake, slack);
  } finally {
    await fake.close();
  }
}

test('events are handed over and acknowledged only when they were accepted', async () => {
  await withSlack(async (fake, slack) => {
    const hooks = recorder((payload) => payload.event_id !== 'Ev2');
    const controller = new AbortController();
    const connected = fake.nextSocket();
    const ended = socketSession({ slack, tokens, hooks, signal: controller.signal });
    await connected;
    const first = fake.nextAck();
    fake.send(fake.envelope(message, 'env-1'));
    assert.deepEqual(await first, { envelope_id: 'env-1' });
    fake.send(fake.envelope({ ...message, event_id: 'Ev2' }, 'env-2'));
    fake.send({ type: 'slash_commands', envelope_id: 'env-3', payload: {} });
    fake.send({ type: 'events_api', payload: message });
    assert.deepEqual(await fake.nextAck(), { envelope_id: 'env-3' });
    assert.deepEqual(fake.acks.map((ack) => ack.envelope_id), ['env-1', 'env-3']);
    assert.deepEqual(hooks.log.filter((entry) => entry[0] === 'receive').map((entry) => entry[1]), ['Ev1', 'Ev2']);
    fake.send({ type: 'disconnect', reason: 'refresh_requested' });
    const result = await ended;
    assert.equal(result.ready, true);
    assert.deepEqual(result.outcome, { ok: true });
    assert.deepEqual(hooks.log.slice(0, 2), [['identity', 'UBOT0001'], ['online']]);
    assert.equal(fake.callsTo('apps.connections.open')[0].authorization, `Bearer ${GOOD_APP}`);
  });
});

test('stopping the connector ends the session cleanly', async () => {
  await withSlack(async (fake, slack) => {
    const controller = new AbortController();
    const connected = fake.nextSocket();
    const ended = socketSession({ slack, tokens, hooks: recorder(), signal: controller.signal });
    const socket = await connected;
    const closed = new Promise((resolve) => socket.once('close', resolve));
    controller.abort();
    const result = await ended;
    assert.deepEqual(result.outcome, { ok: true });
    await closed;
  });
});

test('bad tokens and extra permissions never open a socket', async () => {
  await withSlack(async (fake, slack) => {
    fake.handle('auth.test', () => ({ body: { ok: false, error: 'invalid_auth' } }));
    let result = await socketSession({ slack, tokens, hooks: recorder(), signal: new AbortController().signal });
    assert.deepEqual([result.ready, result.quick, result.outcome.ok, result.outcome.phase], [false, true, false, 'failing']);
    assert.ok(result.outcome.detail.includes('Bot User OAuth Token'));
    fake.handle('auth.test', () => ({ status: 500, body: {} }));
    result = await socketSession({ slack, tokens, hooks: recorder(), signal: new AbortController().signal });
    assert.deepEqual([result.outcome.phase, result.outcome.detail], ['offline', 'Slack answered with HTTP 500']);
    fake.handle('auth.test', () => ({ body: { ok: true, user_id: 'U1', user: 'b', team_id: 'T1', team: 'Acme' }, headers: { 'x-oauth-scopes': 'chat:write,mpim:history' } }));
    result = await socketSession({ slack, tokens, hooks: recorder(), signal: new AbortController().signal });
    assert.equal(result.outcome.phase, 'failing');
    assert.ok(result.outcome.detail.includes('mpim:history'));
    fake.handle('auth.test', undefined);
    fake.handle('apps.connections.open', () => ({ body: { ok: false, error: 'invalid_auth' } }));
    result = await socketSession({ slack, tokens, hooks: recorder(), signal: new AbortController().signal });
    assert.equal(result.outcome.phase, 'failing');
    assert.ok(result.outcome.detail.includes('App-Level Tokens'));
    assert.equal(fake.socketCount, 0);
  });
});

test('a socket address that cannot be reached is reported without its ticket', async () => {
  await withSlack(async (fake, slack) => {
    fake.handle('apps.connections.open', () => ({ body: { ok: true, url: 'ws://127.0.0.1:1/link?ticket=secret-ticket' } }));
    const result = await socketSession({ slack, tokens, hooks: recorder(), signal: new AbortController().signal });
    assert.equal(result.outcome.phase, 'offline');
    assert.ok(result.outcome.detail.startsWith("Can't open the Slack connection ("), result.outcome.detail);
    assert.ok(!result.outcome.detail.includes('secret-ticket'));
  });
});

test('a silent socket is dropped once it has been quiet past the limit and a ping is answered', async () => {
  await withSlack(async (fake, slack) => {
    let clock = 1000;
    const settings = { idleMs: 75000, pingMs: 5, now: () => clock };
    const connected = fake.nextSocket();
    const ended = socketSession({ slack, tokens, hooks: recorder(), signal: new AbortController().signal, settings });
    const socket = await connected;
    const pong = new Promise((resolve) => socket.once('pong', resolve));
    socket.sendPing(Buffer.from('hi'));
    assert.equal((await pong).toString(), 'hi');
    const ping = new Promise((resolve) => socket.once('ping', resolve));
    await ping;
    clock += 75001;
    const result = await ended;
    assert.deepEqual(result.outcome, { ok: false, phase: 'offline', detail: 'The Slack connection went quiet' });
  });
});

test('the connection runs again with growing waits and starts over once it was ready', async () => {
  await withSlack(async (fake, slack) => {
    const waits = [];
    const statuses = [];
    const controller = new AbortController();
    let attempts = 0;
    fake.handle('auth.test', () => {
      attempts += 1;
      if (attempts <= 3) {
        return { status: 500, body: {} };
      }
      return { body: { ok: true, user_id: 'UBOT0001', user: 'b', team_id: 'T001', team: 'Acme' }, headers: { 'x-oauth-scopes': 'chat:write' } };
    });
    const hooks = recorder();
    hooks.status = async (phase, detail) => {
      statuses.push([phase, detail]);
    };
    const online = new Promise((resolve) => {
      hooks.online = async () => resolve();
    });
    const sleep = async (ms) => {
      waits.push(ms);
    };
    const running = runSocketMode({ slack, tokens, hooks, signal: controller.signal, settings: { sleep } });
    await online;
    assert.deepEqual(waits, BACKOFF_MS.slice(0, 3));
    assert.deepEqual(statuses.slice(0, 2), [['connecting', null], ['offline', 'Slack answered with HTTP 500']]);
    fake.send({ type: 'disconnect' });
    await fake.nextSocket();
    controller.abort();
    await running;
    assert.equal(waits[3], BACKOFF_MS[0]);
  });
});
