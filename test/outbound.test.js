import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverRow } from '../src/outbound.js';
import { Slack } from '../src/slack.js';
import { GOOD_BOT, startFakeSlack } from './helpers/fake-slack.js';

function storeOf(files) {
  return {
    async media(sha) {
      const found = files.get(sha);
      if (found === 'error') {
        return { state: 'error' };
      }
      return found === undefined ? { state: 'missing' } : { state: 'found', bytes: found };
    },
  };
}

async function withDelivery(run, files = new Map()) {
  const fake = await startFakeSlack();
  const slack = new Slack({ apiBase: fake.apiBase, allowFile: (url) => url.origin === fake.base, env: {} });
  const context = { slack, bot: GOOD_BOT, daemon: storeOf(files) };
  try {
    await run(fake, context);
  } finally {
    await fake.close();
  }
}

const row = (extra = {}) => ({ id: '1', channel: 'C0FEEDBK', thread_ts: '1712345678.000100', text: 'Fixed in <the> next & build', files: [], attempts: 0, ...extra });
const attachment = (sha, bytes) => ({ sha, name: `${sha}.png`, mime: 'image/png', size: bytes.length });

test('a text reply is escaped and posted into its thread', async () => {
  await withDelivery(async (fake, context) => {
    assert.deepEqual(await deliverRow(context, row()), { outcome: 'delivered', delivery: 'text' });
    const [post] = fake.callsTo('chat.postMessage');
    assert.equal(post.payload.text, 'Fixed in &lt;the&gt; next &amp; build');
    assert.equal(post.payload.thread_ts, '1712345678.000100');
    assert.equal(post.authorization, `Bearer ${GOOD_BOT}`);
  });
});

test('text failures settle the way the daemon expects', async () => {
  await withDelivery(async (fake, context) => {
    fake.handle('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '12' }, body: {} }));
    assert.deepEqual(await deliverRow(context, row()), { outcome: 'limited', seconds: 12 });
    fake.handle('chat.postMessage', () => ({ body: { ok: false, error: 'internal_error' } }));
    assert.equal((await deliverRow(context, row())).outcome, 'retry');
    fake.handle('chat.postMessage', () => ({ body: { ok: false, error: 'is_archived' } }));
    assert.deepEqual(await deliverRow(context, row()), { outcome: 'failed', detail: 'That Slack channel is archived' });
    fake.handle('chat.postMessage', () => ({ body: { ok: false, error: 'not_in_channel' } }));
    assert.ok((await deliverRow(context, row())).detail.includes('/invite'));
    fake.handle('chat.postMessage', () => ({ status: 502, body: {} }));
    const unsure = await deliverRow(context, row());
    assert.equal(unsure.outcome, 'unconfirmed');
    assert.ok(unsure.detail.endsWith('Check the thread before sending it again'));
  });
});

test('attachments follow Slack external upload flow in order', async () => {
  const first = Buffer.from('first-image');
  const second = Buffer.from('second-image');
  await withDelivery(
    async (fake, context) => {
      const outcome = await deliverRow(context, row({ files: [attachment('aa', first), attachment('bb', second)] }));
      assert.deepEqual(outcome, { outcome: 'delivered', delivery: 'attached' });
      assert.deepEqual(fake.calls.filter((call) => !call.method.startsWith('GET')).map((call) => call.method), ['files.getUploadURLExternal', 'files.getUploadURLExternal', 'files.completeUploadExternal']);
      assert.deepEqual(fake.uploads.map((upload) => upload.bytes.toString()), ['first-image', 'second-image']);
      assert.ok(fake.uploads.every((upload) => upload.type === 'application/octet-stream'));
      const [complete] = fake.callsTo('files.completeUploadExternal');
      assert.equal(complete.payload.channel_id, 'C0FEEDBK');
      assert.equal(complete.payload.thread_ts, '1712345678.000100');
      assert.equal(complete.payload.initial_comment, 'Fixed in &lt;the&gt; next &amp; build');
      assert.deepEqual(complete.payload.files.map((file) => file.title), ['aa.png', 'bb.png']);
      assert.equal(fake.callsTo('chat.postMessage').length, 0);
    },
    new Map([['aa', first], ['bb', second]]),
  );
});

test('without the files permission the reply goes out as text with a note', async () => {
  const bytes = Buffer.from('image');
  await withDelivery(
    async (fake, context) => {
      fake.handle('files.getUploadURLExternal', () => ({ body: { ok: false, error: 'missing_scope', needed: 'files:write' } }));
      assert.deepEqual(await deliverRow(context, row({ files: [attachment('aa', bytes)] })), { outcome: 'delivered', delivery: 'fallback_scope' });
      assert.ok(fake.callsTo('chat.postMessage')[0].payload.text.endsWith('which do not include file uploads)'));
      assert.equal(fake.uploads.length, 0);
    },
    new Map([['aa', bytes]]),
  );
  await withDelivery(
    async (fake, context) => {
      fake.handle('files.completeUploadExternal', () => ({ body: { ok: false, error: 'not_allowed' } }));
      assert.equal((await deliverRow(context, row({ files: [attachment('aa', bytes)] }))).delivery, 'fallback_scope');
      assert.equal(fake.callsTo('chat.postMessage').length, 1);
    },
    new Map([['aa', bytes]]),
  );
});

test('files that are gone fall back to text before anything is uploaded', async () => {
  const bytes = Buffer.from('image');
  await withDelivery(async (fake, context) => {
    assert.deepEqual(await deliverRow(context, row({ files: [attachment('aa', bytes)] })), { outcome: 'delivered', delivery: 'fallback_gone' });
    assert.ok(fake.callsTo('chat.postMessage')[0].payload.text.includes('no longer available'));
    assert.equal(fake.uploads.length, 0);
  });
  await withDelivery(
    async (fake, context) => {
      assert.equal((await deliverRow(context, row({ files: [{ sha: 'aa', name: 'a.png', mime: 'image/png', size: null }] }))).delivery, 'fallback_gone');
      assert.equal((await deliverRow(context, row({ files: [attachment('aa', Buffer.from('a longer body'))] }))).delivery, 'fallback_gone');
      assert.equal(fake.uploads.length, 0);
    },
    new Map([['aa', Buffer.from('short')]]),
  );
});

test('an unreadable daemon retries and uncertain uploads are never sent twice', async () => {
  const bytes = Buffer.from('image');
  await withDelivery(
    async (fake, context) => {
      const outcome = await deliverRow(context, row({ files: [attachment('aa', bytes)] }));
      assert.deepEqual(outcome, { outcome: 'retry', detail: 'CommissionAI could not read the attached files' });
      assert.equal(fake.callsTo('chat.postMessage').length, 0);
    },
    new Map([['aa', 'error']]),
  );
  await withDelivery(
    async (fake, context) => {
      fake.handle('upload', () => ({ status: 500, body: 'no' }));
      const outcome = await deliverRow(context, row({ files: [attachment('aa', bytes)] }));
      assert.equal(outcome.outcome, 'unconfirmed');
      assert.equal(fake.callsTo('files.completeUploadExternal').length, 0);
    },
    new Map([['aa', bytes]]),
  );
  await withDelivery(
    async (fake, context) => {
      fake.handle('files.getUploadURLExternal', () => ({ status: 502, body: {} }));
      assert.equal((await deliverRow(context, row({ files: [attachment('aa', bytes)] }))).outcome, 'retry');
      fake.handle('files.getUploadURLExternal', undefined);
      fake.handle('files.completeUploadExternal', () => ({ status: 502, body: {} }));
      assert.equal((await deliverRow(context, row({ files: [attachment('aa', bytes)] }))).outcome, 'unconfirmed');
    },
    new Map([['aa', bytes]]),
  );
});
