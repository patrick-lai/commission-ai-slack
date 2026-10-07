import assert from 'node:assert/strict';
import test from 'node:test';
import { CallError } from '../src/errors.js';
import { Coded } from '../src/scopes.js';
import { Slack } from '../src/slack.js';
import { GOOD_APP, GOOD_BOT, startFakeSlack } from './helpers/fake-slack.js';

async function withSlack(run, options = {}) {
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, allowFile: (url) => url.origin === fake.base, env: {}, ...options });
  try {
    await run(fake, slack);
  } finally {
    await fake.close();
  }
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a failure');
  return null;
}

test('calls carry the bearer token, a user agent and the right body encoding', async () => {
  await withSlack(async (fake, slack) => {
    await slack.channelInfo(GOOD_BOT, 'C0FEEDBK');
    await slack.postMessage(GOOD_BOT, 'C0FEEDBK', '1712345000.000200', 'hello <there>');
    const [info] = fake.callsTo('conversations.info');
    assert.equal(info.authorization, `Bearer ${GOOD_BOT}`);
    assert.equal(info.contentType, 'application/x-www-form-urlencoded');
    assert.deepEqual(info.payload, { channel: 'C0FEEDBK' });
    const [post] = fake.callsTo('chat.postMessage');
    assert.equal(post.contentType, 'application/json');
    assert.deepEqual(post.payload, { channel: 'C0FEEDBK', text: 'hello <there>', mrkdwn: true, parse: 'none', unfurl_links: false, unfurl_media: false, thread_ts: '1712345000.000200' });
    await slack.postMessage(GOOD_BOT, 'C0FEEDBK', null, 'top level');
    assert.ok(!('thread_ts' in fake.callsTo('chat.postMessage')[1].payload));
  });
});

test('auth.test reports the identity and any permission outside the approved list', async () => {
  await withSlack(async (fake, slack) => {
    const identity = await slack.authTest(GOOD_BOT);
    assert.deepEqual(identity, { user_id: 'UBOT0001', bot: 'commissionbot', team_id: 'T001', team: 'Acme', unapproved: [] });
    fake.handle('auth.test', () => ({ body: { ok: true, user_id: 'UBOT0001', user: 'b', team_id: 'T001', team: 'Acme' }, headers: { 'x-oauth-scopes': 'chat:write,mpim:history,files:read' } }));
    assert.deepEqual((await slack.authTest(GOOD_BOT)).unapproved, ['mpim:history']);
    fake.handle('auth.test', () => ({ body: { ok: true, user_id: 'UBOT0001' } }));
    assert.deepEqual((await slack.authTest(GOOD_BOT)).unapproved, []);
  });
});

test('Slack failures arrive as typed errors', async () => {
  await withSlack(async (fake, slack) => {
    fake.handle('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '7' }, body: {} }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'limited', seconds: 7 });
    fake.handle('chat.postMessage', () => ({ status: 429, body: {} }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'limited', seconds: 30 });
    fake.handle('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '999999' }, body: {} }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'limited', seconds: 3600 });
    fake.handle('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '0' }, body: {} }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'limited', seconds: 1 });
    fake.handle('chat.postMessage', () => ({ status: 503, body: {} }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'status', status: 503 });
    fake.handle('chat.postMessage', () => ({ status: 302, headers: { location: `${fake.base}/elsewhere` }, body: {} }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'status', status: 302 });
    fake.handle('chat.postMessage', () => ({ body: { ok: false, error: 'missing_scope', needed: 'chat:write' } }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'api', code: 'missing_scope', needed: 'chat:write' });
    fake.handle('chat.postMessage', () => ({ body: { ok: false } }));
    assert.deepEqual((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail, { kind: 'api', code: 'unknown_error', needed: null });
    fake.handle('chat.postMessage', () => ({ body: 'not json at all' }));
    assert.equal((await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'))).detail.kind, 'unsure');
  });
});

test('a Slack that cannot be reached is reported as nothing sent', async () => {
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, env: {} });
  await fake.close();
  const error = await failure(slack.postMessage(GOOD_BOT, 'C1', null, 'x'));
  assert.ok(error instanceof CallError);
  assert.equal(error.detail.kind, 'unsent');
  assert.ok(!error.detail.text.includes('127.0.0.1:'), error.detail.text);
});

test('verify checks the shapes, the permissions and both tokens', async () => {
  await withSlack(async (fake, slack) => {
    assert.equal((await slack.verify(` ${GOOD_BOT} `, `${GOOD_APP}\n`)).team, 'Acme');
    assert.equal(fake.callsTo('apps.connections.open')[0].authorization, `Bearer ${GOOD_APP}`);
    const shape = await failure(slack.verify('nope', GOOD_APP));
    assert.ok(shape instanceof Coded && shape.code === 'bridge.bad_token');
    fake.handle('auth.test', () => ({ body: { ok: false, error: 'invalid_auth' } }));
    const bad = await failure(slack.verify(GOOD_BOT, GOOD_APP));
    assert.deepEqual([bad.code, bad.message], ['bridge.bad_token', 'Slack rejected the bot token: reinstall the app and copy the Bot User OAuth Token (xoxb-) again']);
    fake.handle('auth.test', () => ({ body: { ok: true, user_id: 'U1', user: 'b', team_id: 'T1', team: 'Acme' }, headers: { 'x-oauth-scopes': 'chat:write,admin' } }));
    const locked = await failure(slack.verify(GOOD_BOT, GOOD_APP));
    assert.equal(locked.code, 'bridge.scope_locked');
    assert.ok(locked.message.includes('admin'));
    fake.handle('auth.test', () => ({ status: 500, body: {} }));
    assert.equal((await failure(slack.verify(GOOD_BOT, GOOD_APP))).code, 'bridge.slack_unreachable');
    fake.handle('auth.test', undefined);
    fake.handle('auth.test', () => ({ body: { ok: true, user_id: 'U1', user: 'b', team_id: 'T1', team: 'Acme' }, headers: { 'x-oauth-scopes': 'chat:write' } }));
    fake.handle('apps.connections.open', () => ({ body: { ok: false, error: 'invalid_auth' } }));
    const app = await failure(slack.verify(GOOD_BOT, GOOD_APP));
    assert.ok(app.message.includes('App-Level Tokens'));
  });
});

test('channel lists page through Slack and survive a failing workspace listing', async () => {
  await withSlack(async (fake, slack) => {
    const pages = [
      { channels: [{ id: 'C0LISTED01', name: 'zeta', is_private: false }, { id: 'C0LISTED02', name: 'Alpha', is_private: true }], response_metadata: { next_cursor: 'page-2' } },
      { channels: [{ id: 'C0LISTED03', name: 'beta' }, { id: 'C0JOINED01', name: 'joined', is_member: false }, 'junk', { name: 'no-id' }] },
    ];
    fake.handle('conversations.list', ({ payload }) => ({ body: { ok: true, ...(payload.cursor === 'page-2' ? pages[1] : pages[0]) } }));
    const channels = await slack.listChannels(GOOD_BOT);
    assert.deepEqual(channels.map((channel) => [channel.name, channel.is_member]), [['Alpha', false], ['beta', false], ['joined', true], ['zeta', false]]);
    assert.deepEqual(fake.callsTo('conversations.list').map((call) => call.payload.cursor ?? null), [null, 'page-2']);
    assert.equal(fake.callsTo('conversations.list')[0].payload.types, 'public_channel,private_channel');
    assert.equal(fake.callsTo('conversations.list')[0].payload.exclude_archived, 'true');
    fake.handle('conversations.list', () => ({ body: { ok: false, error: 'missing_scope', needed: 'channels:read' } }));
    assert.deepEqual((await slack.listChannels(GOOD_BOT)).map((channel) => channel.id), ['C0JOINED01']);
    fake.handle('users.conversations', () => ({ body: { ok: true, channels: [] } }));
    assert.equal((await failure(slack.listChannels(GOOD_BOT))).detail.code, 'missing_scope');
  });
});

test('names are looked up once and picked in the same order', async () => {
  await withSlack(async (fake, slack) => {
    assert.equal(await slack.userName(GOOD_BOT, 'U999'), 'Dana Lee');
    assert.equal(await slack.userName(GOOD_BOT, 'U999'), 'Dana Lee');
    assert.equal(fake.callsTo('users.info').length, 1);
    assert.equal(await slack.userName('', 'U777'), null);
    const answers = {
      U1: { profile: { display_name: ' ' }, real_name: 'Real Name', name: 'handle' },
      U2: { profile: { display_name: '', real_name: 'Profile Real' }, name: 'handle2' },
      U3: { name: 'handle3' },
      U4: {},
    };
    fake.handle('users.info', ({ payload }) => ({ body: { ok: true, user: answers[payload.user] } }));
    assert.equal(await slack.userName(GOOD_BOT, 'U1'), 'Real Name');
    assert.equal(await slack.userName(GOOD_BOT, 'U2'), 'Profile Real');
    assert.equal(await slack.userName(GOOD_BOT, 'U3'), 'handle3');
    assert.equal(await slack.userName(GOOD_BOT, 'U4'), null);
    fake.handle('users.info', () => ({ body: { ok: false, error: 'user_not_found' } }));
    assert.equal(await slack.userName(GOOD_BOT, 'U5'), null);
  });
});

test('direct messages and joins return what Slack answered', async () => {
  await withSlack(async (fake, slack) => {
    assert.equal(await slack.openDirect(GOOD_BOT, 'U0ABCDEFG'), 'D0DIRECTMSG');
    assert.deepEqual(fake.callsTo('conversations.open')[0].payload, { users: 'U0ABCDEFG' });
    fake.handle('conversations.open', () => ({ body: { ok: true } }));
    assert.equal((await failure(slack.openDirect(GOOD_BOT, 'U0ABCDEFG'))).detail.kind, 'unsure');
    await slack.joinChannel(GOOD_BOT, 'C0FEEDBK');
    assert.deepEqual(fake.callsTo('conversations.join')[0].payload, { channel: 'C0FEEDBK' });
    fake.handle('conversations.info', () => ({ body: { ok: true } }));
    assert.equal((await failure(slack.channelInfo(GOOD_BOT, 'C0FEEDBK'))).detail.kind, 'unsure');
  });
});

test('downloads only trust Slack file hosts and say why a file was skipped', async () => {
  await withSlack(async (fake, slack) => {
    const file = (path, extra = {}) => ({ id: 'F1', name: 'shot.png', mime: 'image/png', url: `${fake.base}${path}`, size: 10, ...extra });
    fake.files.set('ok.png', { body: Buffer.from('pixels'), type: 'image/png' });
    fake.files.set('page', { body: Buffer.from('<html>sign in</html>'), type: 'text/html; charset=utf-8' });
    fake.files.set('forbidden', { status: 403, body: Buffer.from('no') });
    fake.files.set('missing-auth', { status: 401, body: Buffer.from('no') });
    fake.files.set('moved', { status: 302, headers: { location: 'https://evil.example.com/steal' }, body: Buffer.alloc(0) });
    fake.files.set('broken', { status: 500, body: Buffer.from('oops') });
    fake.files.set('big.bin', { body: Buffer.alloc(2048), type: 'application/octet-stream' });
    const downloaded = await slack.download(GOOD_BOT, file('/files/ok.png'), 1024);
    assert.equal(downloaded.bytes.toString(), 'pixels');
    assert.equal(fake.calls.find((call) => call.method === 'GET /files/ok.png').authorization, `Bearer ${GOOD_BOT}`);
    assert.deepEqual(await slack.download(GOOD_BOT, file('/files/page'), 1024), { skip: 'no_access' });
    assert.equal((await slack.download(GOOD_BOT, file('/files/page', { mime: 'text/html' }), 1024)).bytes.length, 20);
    assert.deepEqual(await slack.download(GOOD_BOT, file('/files/forbidden'), 1024), { skip: 'no_access' });
    assert.deepEqual(await slack.download(GOOD_BOT, file('/files/missing-auth'), 1024), { skip: 'no_access' });
    assert.deepEqual(await slack.download(GOOD_BOT, file('/files/moved'), 1024), { skip: 'no_access' });
    assert.deepEqual(await slack.download(GOOD_BOT, file('/files/broken'), 1024), { skip: 'failed' });
    assert.deepEqual(await slack.download(GOOD_BOT, file('/files/big.bin'), 1024), { skip: 'too_large' });
    assert.deepEqual(await slack.download(GOOD_BOT, { ...file('/files/ok.png'), url: 'https://evil.example.com/x.png' }, 1024), { skip: 'failed' });
    assert.deepEqual(await slack.download(GOOD_BOT, { ...file('/files/ok.png'), url: 'not a url' }, 1024), { skip: 'failed' });
    assert.ok(!fake.calls.some((call) => call.method === 'GET /steal'));
  });
});

test('file info and upload slots reject addresses outside Slack', async () => {
  await withSlack(async (fake, slack) => {
    fake.handle('files.info', () => ({ body: { ok: true, file: { id: 'F1', name: 'a.png', mimetype: 'image/png', url_private: `${fake.base}/files/a.png`, size: 4 } } }));
    assert.equal((await slack.fileInfo(GOOD_BOT, 'F1')).url, `${fake.base}/files/a.png`);
    fake.handle('files.info', () => ({ body: { ok: true, file: { id: 'F1', file_access: 'check_file_info' } } }));
    assert.equal((await failure(slack.fileInfo(GOOD_BOT, 'F1'))).detail.kind, 'unsure');
    const strict = new Slack({ apiBase: fake.apiBase, env: {} });
    assert.equal((await failure(strict.uploadSlot(GOOD_BOT, 'a.png', 4))).detail.kind, 'unsure');
    const slot = await slack.uploadSlot(GOOD_BOT, 'a.png', 4);
    assert.equal(slot.url, `${fake.base}/upload/a.png`);
    assert.deepEqual(fake.callsTo('files.getUploadURLExternal')[0].payload, { filename: 'a.png', length: '4' });
  });
});
