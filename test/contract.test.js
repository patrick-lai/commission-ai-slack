import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runCall } from '../src/commands.js';
import { Daemon, DaemonError, PROTOCOL, TOKEN_HEADER } from '../src/daemon.js';
import { deliverRow } from '../src/outbound.js';
import { Slack } from '../src/slack.js';
import { sameShape } from './helpers/fake-daemon.js';
import { GOOD_APP, GOOD_BOT, startFakeSlack } from './helpers/fake-slack.js';

const contract = JSON.parse(readFileSync(new URL('../vectors/contract.json', import.meta.url), 'utf8'));

function answering(body, status = 200) {
  const sent = [];
  const send = async (options) => {
    sent.push(options);
    return { status, headers: {}, url: options.url, body: Buffer.from(JSON.stringify(body)) };
  };
  return { daemon: new Daemon({ endpoint: 'http://127.0.0.1:1', token: 'cmc_x', send }), sent };
}

test('the header, protocol and long-poll limit match the daemon', () => {
  assert.equal(TOKEN_HEADER, contract.header);
  assert.equal(PROTOCOL, contract.protocol);
  assert.equal(25000, contract.wait_ms_max);
});

test('the requests this client builds have the shapes the daemon documents', async () => {
  const { daemon, sent } = answering(contract.session.responses[0]);
  await daemon.session(0, '0.1.0');
  const request = JSON.parse(sent[0].body);
  assert.ok(sameShape(request, contract.session.request), JSON.stringify(request));
  assert.equal(sent[0].url.pathname, contract.session.path);
  assert.equal(sent[0].headers[TOKEN_HEADER], 'cmc_x');
  const status = answering({ ok: true });
  await status.daemon.status(contract.status.requests[0]);
  assert.equal(status.sent[0].method, contract.status.method);
  assert.equal(status.sent[0].url.pathname, contract.status.path);
  const claim = answering(contract.claim.responses[1]);
  await claim.daemon.claim();
  assert.ok(sameShape(JSON.parse(claim.sent[0].body), contract.claim.request));
  assert.equal(claim.sent[0].url.pathname, contract.claim.path);
  const next = answering(contract.next.responses.at(-1));
  await next.daemon.nextCommand();
  assert.ok(sameShape(JSON.parse(next.sent[0].body), contract.next.request));
  assert.equal(next.sent[0].url.pathname, contract.next.path);
  const result = answering({ ok: true });
  await result.daemon.result('0001-abc', { outcome: 'released' });
  assert.equal(result.sent[0].url.pathname, contract.result.path.replace('{id}', '0001-abc'));
  const answer = answering({ ok: true });
  await answer.daemon.commandResult('cmd_1', { ok: true, value: { kind: 'done' } });
  assert.equal(answer.sent[0].url.pathname, contract.answer.path.replace('{id}', 'cmd_1'));
  const inbound = answering(contract.inbound.responses[1]);
  const reply = await inbound.daemon.inbound(contract.inbound.request);
  assert.deepEqual(reply, contract.inbound.responses[1]);
  assert.equal(inbound.sent[0].url.pathname, contract.inbound.path);
  const media = answering({ sha: 'a'.repeat(64) });
  assert.deepEqual(await media.daemon.stageMedia('shot.png', 'image/png', Buffer.from('x')), { sha: 'a'.repeat(64) });
  assert.equal(media.sent[0].url.pathname + media.sent[0].url.search, '/v1/connectors/slack/media?name=shot.png');
});

test('every answer this client produces has the shape of a documented answer', async () => {
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, allowFile: (url) => url.origin === fake.base, env: {} });
  fake.files.set('shot.png', { body: Buffer.from('pixels'), type: 'image/png' });
  const stage = async () => ({ sha: 'a'.repeat(64) });
  const context = { slack, credentials: { bot_token: GOOD_BOT, app_token: GOOD_APP }, daemon: { stageMedia: stage } };
  try {
    const documented = contract.answer.requests;
    for (const { command } of contract.next.responses.filter((entry) => entry.command !== null)) {
      const call = JSON.parse(JSON.stringify(command.call).replaceAll('https://files.slack.com/files-pri/T-F1/shot.png', `${fake.base}/files/shot.png`));
      if (call.kind === 'prepare') {
        call.message.files[0].size = 6;
      }
      const produced = await runCall(context, call);
      assert.equal(produced.ok, true, JSON.stringify(call));
      const match = documented.find((entry) => entry.ok && entry.value.kind === produced.value.kind);
      assert.ok(match, `a documented ${produced.value.kind} answer`);
      assert.ok(sameShape(produced, match), `${JSON.stringify(produced)} vs ${JSON.stringify(match)}`);
    }
    const kinds = new Set(documented.filter((entry) => entry.ok).map((entry) => entry.value.kind));
    assert.deepEqual([...kinds].sort(), ['channel', 'channels', 'direct', 'done', 'name', 'prepared', 'verified']);
    fake.handle('conversations.info', () => ({ body: { ok: false, error: 'channel_not_found' } }));
    const failed = await runCall(context, { kind: 'channel_info', channel: 'C0NOPE' });
    assert.ok(documented.some((entry) => !entry.ok && sameShape(entry, failed)));
    const bad = await runCall(context, { kind: 'verify', bot_token: 'nope', app_token: GOOD_APP });
    assert.ok(documented.some((entry) => !entry.ok && entry.error.kind === 'verify' && sameShape(entry, bad)));
  } finally {
    await fake.close();
  }
});

test('every outcome this client reports has the shape of a documented outcome', async () => {
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, allowFile: (url) => url.origin === fake.base, env: {} });
  const bytes = Buffer.from('image');
  const daemon = { media: async (sha) => (sha === 'aa' ? { state: 'found', bytes } : { state: 'missing' }) };
  const context = { slack, bot: GOOD_BOT, daemon };
  const row = (extra = {}) => ({ id: '1', channel: 'C0FEEDBK', thread_ts: '1.1', text: 'x', files: [], attempts: 0, ...extra });
  const file = (sha) => ({ sha, name: 'a.png', mime: 'image/png', size: 5 });
  try {
    const produced = [];
    produced.push(await deliverRow(context, row()));
    produced.push(await deliverRow(context, row({ files: [file('aa')] })));
    produced.push(await deliverRow(context, row({ files: [file('zz')] })));
    fake.handle('files.getUploadURLExternal', () => ({ body: { ok: false, error: 'missing_scope' } }));
    produced.push(await deliverRow(context, row({ files: [file('aa')] })));
    fake.handle('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '5' }, body: {} }));
    produced.push(await deliverRow(context, row()));
    fake.handle('chat.postMessage', () => ({ body: { ok: false, error: 'internal_error' } }));
    produced.push(await deliverRow(context, row()));
    fake.handle('chat.postMessage', () => ({ status: 502, body: {} }));
    produced.push(await deliverRow(context, row()));
    fake.handle('chat.postMessage', () => ({ body: { ok: false, error: 'is_archived' } }));
    produced.push(await deliverRow(context, row()));
    produced.push({ outcome: 'released' });
    const documented = contract.result.requests;
    for (const outcome of produced) {
      assert.ok(documented.some((entry) => sameShape(entry, outcome) && entry.outcome === outcome.outcome && entry.delivery === outcome.delivery), JSON.stringify(outcome));
    }
    assert.deepEqual(new Set(documented.map((entry) => entry.outcome)), new Set(produced.map((outcome) => outcome.outcome)));
    assert.deepEqual(new Set(documented.filter((entry) => entry.delivery).map((entry) => entry.delivery)), new Set(produced.filter((outcome) => outcome.delivery).map((outcome) => outcome.delivery)));
  } finally {
    await fake.close();
  }
});

test('documented refusals end the connector only when retrying cannot help', () => {
  const final = new Set(['connector.token_required', 'connector.token_invalid', 'connector.token_revoked', 'connector.scope_forbidden', 'connector.route_forbidden', 'connector.protocol', 'connector.already_attached']);
  assert.deepEqual(new Set(contract.errors.map((entry) => entry.code).filter((code) => final.has(code))), final);
  for (const { code, status } of contract.errors) {
    assert.equal(new DaemonError({ status, code, message: 'x' }).fatal, final.has(code), code);
  }
});
