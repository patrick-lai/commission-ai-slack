import assert from 'node:assert/strict';
import test from 'node:test';
import { Exit, runConnector } from '../src/connector.js';
import { Daemon } from '../src/daemon.js';
import { Slack } from '../src/slack.js';
import { startFakeDaemon } from './helpers/fake-daemon.js';
import { GOOD_APP, GOOD_BOT, startFakeSlack } from './helpers/fake-slack.js';

const credentials = { bot_token: GOOD_BOT, app_token: GOOD_APP };
const message = { team_id: 'T001', event_id: 'Ev1', event: { type: 'message', user: 'U123', channel: 'C0FEEDBK', text: '<@UBOT0001> hello <@U999>', ts: '1712345678.000100', client_msg_id: 'cm-1' } };

async function withConnector(run, { token } = {}) {
  const daemon = await startFakeDaemon();
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, allowFile: (url) => url.origin === fake.base, env: {} });
  const controller = new AbortController();
  const running = runConnector({ daemon: new Daemon({ endpoint: daemon.endpoint, token: token ?? daemon.token }), slack, version: '0.1.0', signal: controller.signal, settings: { daemonBackoffMs: [1] } });
  try {
    await run({ daemon, fake, slack, controller, running });
  } finally {
    controller.abort();
    await running;
    await fake.close();
    await daemon.close();
  }
}

test('credentials start the connection and status reports follow it', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    const status = await online;
    assert.deepEqual(status.identity, { user_id: 'UBOT0001', bot: 'commissionbot', team_id: 'T001', team: 'Acme' });
    const phases = daemon.state.statuses.map((entry) => entry.phase);
    assert.equal(phases[0], 'connecting');
    assert.ok(daemon.state.sessions.every((session) => session.protocol === 1 && session.version === '0.1.0'));
    assert.equal(fake.socketCount, 1);
    assert.ok(daemon.state.requests.every((request) => request.token === daemon.token && !request.hasOrigin));
  });
});

test('removing the credentials closes the connection and restoring them opens it again', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await online;
    const socket = fake.socket;
    const closed = new Promise((resolve) => socket.once('close', resolve));
    daemon.setCredentials(null);
    await closed;
    const again = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await again;
    assert.equal(fake.socketCount, 2);
  });
});

test('a Slack message becomes an inbound call and is acknowledged only when the daemon took it', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await online;
    const accepted = fake.nextAck();
    fake.send(fake.envelope(message, 'env-1'));
    assert.deepEqual(await accepted, { envelope_id: 'env-1' });
    const [inbound] = daemon.state.inbound;
    assert.equal(inbound.event_id, 'Ev1');
    assert.equal(inbound.client_msg_id, 'cm-1');
    assert.deepEqual(inbound.message, { provider: 'slack', workspace: 'T001', conversation: 'C0FEEDBK', thread: null, sender_id: 'U123', sender_name: null, text: '<@UBOT0001> hello <@U999>', id: '1712345678.000100', files: [], mentioned: true });
    daemon.state.inboundReply = () => ({ status: 503, body: { code: 'bridge.backlog_full', message: 'full' } });
    const refused = daemon.once('inbound');
    fake.send(fake.envelope({ ...message, event_id: 'Ev2' }, 'env-2'));
    await refused;
    fake.send({ type: 'slash_commands', envelope_id: 'env-3', payload: {} });
    assert.deepEqual(await fake.nextAck(), { envelope_id: 'env-3' });
    assert.deepEqual(fake.acks.map((ack) => ack.envelope_id), ['env-1', 'env-3']);
    fake.send(fake.envelope({ event: { type: 'reaction_added' } }, 'env-4'));
    assert.deepEqual(await fake.nextAck(), { envelope_id: 'env-4' });
    assert.equal(daemon.state.inbound.length, 2);
  });
});

test('the unlinked notice from the daemon is posted into the thread after the acknowledgement', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await online;
    daemon.state.inboundReply = () => ({ status: 200, body: { accepted: true, notice: { conversation: 'C0FEEDBK', thread_ts: '1712345678.000100', text: 'Not connected to <#C0FEEDBK> & more' } } });
    const posted = fake.nextCall('chat.postMessage');
    fake.send(fake.envelope(message, 'env-1'));
    const call = await posted;
    assert.deepEqual(call.payload.thread_ts, '1712345678.000100');
    assert.equal(call.payload.text, 'Not connected to &lt;#C0FEEDBK&gt; &amp; more');
  });
});

test('queued replies are delivered and their outcome is reported', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await online;
    const reported = daemon.nextWhere('result', ({ id }) => id === 'row-1');
    daemon.pushOutbox({ id: 'row-1', channel: 'C0FEEDBK', thread_ts: '1.1', text: 'done', files: [], attempts: 0 });
    assert.deepEqual((await reported).outcome, { outcome: 'delivered', delivery: 'text' });
    fake.handle('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '9' }, body: {} }));
    const limited = daemon.nextWhere('result', ({ id }) => id === 'row-2');
    daemon.pushOutbox({ id: 'row-2', channel: 'C0FEEDBK', thread_ts: '1.1', text: 'again', files: [], attempts: 0 });
    assert.deepEqual((await limited).outcome, { outcome: 'limited', seconds: 9 });
    daemon.state.media.set('aa', Buffer.from('image'));
    fake.handle('chat.postMessage', undefined);
    const attached = daemon.nextWhere('result', ({ id }) => id === 'row-3');
    daemon.pushOutbox({ id: 'row-3', channel: 'C0FEEDBK', thread_ts: '1.1', text: 'with a picture', files: [{ sha: 'aa', name: 'a.png', mime: 'image/png', size: 5 }], attempts: 0 });
    assert.deepEqual((await attached).outcome, { outcome: 'delivered', delivery: 'attached' });
    assert.equal(fake.uploads[0].bytes.toString(), 'image');
  });
});

test('requests from the settings screens run on the connector and come back typed', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await online;
    const info = await daemon.pushCommand({ kind: 'channel_info', channel: 'C0FEEDBK' });
    assert.deepEqual(info, { ok: true, value: { kind: 'channel', channel: { id: 'C0FEEDBK', name: 'feedback', is_private: false, is_member: true } }, error: null });
    assert.deepEqual(await daemon.pushCommand({ kind: 'join_channel', channel: 'C0FEEDBK' }), { ok: true, value: { kind: 'done' }, error: null });
    assert.deepEqual(await daemon.pushCommand({ kind: 'open_direct', user: 'U0ABCDEFG' }), { ok: true, value: { kind: 'direct', conversation: 'D0DIRECTMSG' }, error: null });
    assert.deepEqual(await daemon.pushCommand({ kind: 'user_name', user: 'U999' }), { ok: true, value: { kind: 'name', name: 'Dana Lee' }, error: null });
    const joined = await daemon.pushCommand({ kind: 'joined_channels' });
    assert.deepEqual(joined.value.channels.map((channel) => [channel.id, channel.is_member]), [['C0JOINED01', true]]);
    const listed = await daemon.pushCommand({ kind: 'list_channels' });
    assert.deepEqual(listed.value.channels.map((channel) => channel.id), ['C0JOINED01', 'C0LISTED01']);
    assert.deepEqual(await daemon.pushCommand({ kind: 'post_message', channel: 'C0FEEDBK', thread_ts: null, text: 'Hello from CommissionAI.' }), { ok: true, value: { kind: 'done' }, error: null });
    assert.equal(fake.callsTo('chat.postMessage').at(-1).payload.text, 'Hello from CommissionAI.');
    fake.handle('conversations.info', () => ({ body: { ok: false, error: 'channel_not_found' } }));
    assert.deepEqual(await daemon.pushCommand({ kind: 'channel_info', channel: 'C0NOPE' }), { ok: false, value: null, error: { kind: 'api', code: 'channel_not_found', needed: null } });
    assert.deepEqual(await daemon.pushCommand({ kind: 'mystery' }), { ok: false, value: null, error: { kind: 'verify', code: 'connector.command_unknown', message: 'The Slack connector does not know that request' } });
  });
});

test('new tokens are verified with the tokens in the request, not the saved ones', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const answer = await daemon.pushCommand({ kind: 'verify', bot_token: GOOD_BOT, app_token: GOOD_APP });
    assert.deepEqual(answer, { ok: true, value: { kind: 'verified', team: 'Acme' }, error: null });
    assert.equal(fake.callsTo('auth.test')[0].authorization, `Bearer ${GOOD_BOT}`);
    const bad = await daemon.pushCommand({ kind: 'verify', bot_token: 'nope', app_token: GOOD_APP });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'bridge.bad_token');
    const unconfigured = await daemon.pushCommand({ kind: 'channel_info', channel: 'C0FEEDBK' });
    assert.deepEqual(unconfigured, { ok: false, value: null, error: { kind: 'verify', code: 'bridge.not_configured', message: 'Add the Slack bot token and app token first' } });
  });
});

test('preparing a message resolves names, stages files and notes what was skipped', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await online;
    fake.files.set('shot.png', { body: Buffer.from('pixels'), type: 'image/png' });
    const file = (id, name, mime, path, size = 6) => ({ id, name, mime, url: `${fake.base}/files/${path}`, size });
    const call = {
      kind: 'prepare',
      bot_user: 'UBOT0001',
      limits: { cap_bytes: 1024, max_files: 10 },
      message: {
        provider: 'slack',
        workspace: 'T001',
        conversation: 'C0FEEDBK',
        thread: null,
        sender_id: 'U123',
        sender_name: null,
        text: '<@UBOT0001> hi <@U999>, see <https://example.com/a|the report>',
        id: '1712345678.000100',
        files: [file('F1', 'shot.png', 'image/png', 'shot.png'), file('F2', 'doc.exe', 'application/x-msdownload', 'doc.exe', 2), file('F3', 'huge.png', 'image/png', 'shot.png', 5000)],
        mentioned: true,
      },
    };
    const answer = await daemon.pushCommand(call);
    assert.equal(answer.ok, true);
    const { prepared } = answer.value;
    assert.deepEqual(daemon.state.staged.map((entry) => [entry.name, entry.mime, entry.bytes.toString()]), [['shot.png', 'image/png', 'pixels']]);
    assert.deepEqual(prepared, { sender: 'Dana Lee', body: 'hi ＠Dana Lee, see the report (https://example.com/a)', note: '(1 file skipped: too large, 1 file skipped: unsupported type)', attachments: [daemon.state.staged[0].sha] });
  });
});

test('staging refusals become skip reasons and the file limit is honoured', async () => {
  await withConnector(async ({ daemon, fake }) => {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials(credentials);
    await online;
    fake.files.set('shot.png', { body: Buffer.from('pixels'), type: 'image/png' });
    const file = (id) => ({ id, name: `${id}.png`, mime: 'image/png', url: `${fake.base}/files/shot.png`, size: 6 });
    const base = { kind: 'prepare', bot_user: 'UBOT0001', limits: { cap_bytes: 1024, max_files: 1 }, message: { provider: 'slack', workspace: 'T001', conversation: 'C0FEEDBK', thread: null, sender_id: 'U123', sender_name: null, text: 'x', id: '1.1', files: [file('F1'), file('F2')], mentioned: false } };
    assert.equal((await daemon.pushCommand(base)).value.prepared.note, '(1 file skipped: too many files)');
    assert.equal(daemon.state.staged.length, 1);
    daemon.state.stageReply = { status: 400, body: { code: 'hub.media_too_large', message: 'big' } };
    assert.equal((await daemon.pushCommand(base)).value.prepared.note, '(2 files skipped: too large)');
    daemon.state.stageReply = { status: 400, body: { code: 'hub.media_unsupported', message: 'no' } };
    assert.equal((await daemon.pushCommand(base)).value.prepared.note, '(2 files skipped: unsupported type)');
    daemon.state.stageReply = { status: 500, body: { code: 'internal.error', message: 'oops' } };
    assert.equal((await daemon.pushCommand(base)).value.prepared.note, "(2 files skipped: couldn't be downloaded)");
  });
});

test('a revoked token ends the connector without retrying', async () => {
  const daemon = await startFakeDaemon();
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, env: {} });
  const controller = new AbortController();
  try {
    const exit = await runConnector({ daemon: new Daemon({ endpoint: daemon.endpoint, token: 'cmc_wrong' }), slack, version: '0.1.0', signal: controller.signal, settings: { daemonBackoffMs: [1] } });
    assert.ok(exit instanceof Exit);
    assert.deepEqual([exit.reason, exit.code], ['connector.token_invalid', 2]);
    assert.equal(daemon.state.requests.length, 1);
  } finally {
    await fake.close();
    await daemon.close();
  }
});

test('a protocol or attach refusal is final', async () => {
  const daemon = await startFakeDaemon();
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, env: {} });
  daemon.state.refuse.set('/v1/connectors/slack/session', { status: 409, code: 'connector.protocol' });
  try {
    const exit = await runConnector({ daemon: new Daemon({ endpoint: daemon.endpoint, token: daemon.token }), slack, version: '0.1.0', signal: new AbortController().signal, settings: { daemonBackoffMs: [1] } });
    assert.deepEqual([exit.reason, exit.code], ['connector.protocol', 2]);
  } finally {
    await fake.close();
    await daemon.close();
  }
});

test('a daemon that stays away ends the connector after a bounded number of tries', async () => {
  const daemon = await startFakeDaemon();
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, env: {} });
  const endpoint = daemon.endpoint;
  await daemon.close();
  try {
    const exit = await runConnector({ daemon: new Daemon({ endpoint, token: 'cmc_testtoken' }), slack, version: '0.1.0', signal: new AbortController().signal, settings: { daemonBackoffMs: [1] } });
    assert.deepEqual([exit.reason, exit.code], ['connector.daemon_unreachable', 3]);
  } finally {
    await fake.close();
  }
});
