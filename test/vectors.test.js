import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CallError, describe, errorCode, filesUnavailable, isAuth } from '../src/errors.js';
import { parseEvent, eventKeys } from '../src/events.js';
import { FILES_GONE_NOTE, FILES_SCOPE_NOTE, fallbackText, sentAfter } from '../src/outbound.js';
import { redact } from '../src/redact.js';
import { APP_PREFIX, BOT_PREFIX, Coded, DEFAULT_APP_DESCRIPTION, DEFAULT_APP_NAME, EVENTS, SCOPES, TOLERATED_SCOPES, checkTokenShape, manifestFor, scopeLocked, unapprovedScopes } from '../src/scopes.js';
import { CHANNEL_CAP, NAME_CACHE, badToken, completePayload, mergeChannels, slotOf, uploadForm } from '../src/slack.js';
import { BACKOFF_MS, IDLE_TIMEOUT_MS, PING_EVERY_MS, socketError, wentQuiet } from '../src/socket.js';
import { MAX_FILES, MAX_TEXT_CHARS, allowedFileUrl, defang, escapeText, mentionIds, plain, skippedNote, supportedMime } from '../src/text.js';

function load(name) {
  return JSON.parse(readFileSync(new URL(`../vectors/${name}.json`, import.meta.url), 'utf8'));
}

const events = load('events');
const text = load('text');
const api = load('api');
const policy = load('policy');

function callError(wire) {
  return new CallError(wire).detail;
}

test('every transport vector file is claimed by this client or by the daemon', () => {
  const index = load('index');
  assert.deepEqual(Object.keys(index).sort(), ['contract', 'daemon', 'transport']);
  assert.deepEqual(index.transport.sort(), ['api', 'events', 'text']);
  assert.deepEqual(index.daemon, ['policy']);
  assert.ok(Object.keys(policy).length > 0);
});

test('parse_event keeps, drops and keys events the way the daemon expects', () => {
  assert.ok(events.parse_event.length >= 30);
  for (const row of events.parse_event) {
    const parsed = parseEvent(row.payload, row.bot_user);
    const expected = row.expected;
    if (expected === null) {
      assert.equal(parsed, null, row.name);
      continue;
    }
    assert.notEqual(parsed, null, row.name);
    assert.deepEqual({ event_id: parsed.event_id, client_msg_id: parsed.client_msg_id, message: parsed.message, keys: eventKeys(parsed) }, expected, row.name);
  }
});

test('long text is cut at the character cap and constants match', () => {
  const { unit, count, expected_chars: expectedChars } = events.truncation;
  const payload = { event: { type: 'message', user: 'U123', channel: 'C0FEEDBK', ts: '1.1', text: unit.repeat(count) } };
  assert.equal(Array.from(parseEvent(payload, '').message.text).length, expectedChars);
  assert.equal(MAX_TEXT_CHARS, events.constants.max_text_chars);
  assert.equal(MAX_FILES, events.constants.max_files);
});

test('mrkdwn becomes plain text exactly as before', () => {
  for (const row of text.plain) {
    assert.equal(plain(row.text, row.bot_user, new Map(Object.entries(row.names))), row.expected, JSON.stringify(row.text));
  }
  for (const row of text.defang) {
    assert.equal(defang(row.text), row.expected, JSON.stringify(row.text));
  }
  for (const row of text.escape_text) {
    assert.equal(escapeText(row.text), row.expected);
  }
  for (const row of text.mention_ids) {
    assert.deepEqual(mentionIds(row.text), row.expected, JSON.stringify(row.text));
  }
});

test('file notes, types and hosts follow the in-tree rules', () => {
  for (const row of text.skipped_note) {
    assert.equal(skippedNote(row.skips), row.expected, JSON.stringify(row.skips));
  }
  for (const row of text.supported_mime) {
    assert.equal(supportedMime(row.mime), row.expected, JSON.stringify(row.mime));
  }
  for (const row of text.allowed_file_url) {
    assert.equal(allowedFileUrl(row.url), row.expected, row.url);
  }
});

test('Slack failures read the same and map to the same retry decisions', () => {
  for (const row of api.describe) {
    const error = callError(row.error);
    assert.equal(describe(row.method, error), row.expected, `${row.method} ${JSON.stringify(row.error)}`);
    assert.equal(isAuth(error), row.is_auth);
    assert.equal(filesUnavailable(error), row.files_unavailable);
    assert.equal(errorCode(error), row.code);
  }
  for (const row of api.sent_after) {
    assert.deepEqual(sentAfter(row.stage, callError(row.error)), row.expected, `${row.stage} ${JSON.stringify(row.error)}`);
  }
  for (const row of api.fallback_text) {
    assert.equal(fallbackText(row.text, row.fallback), row.expected);
  }
  for (const row of api.bad_token) {
    const failure = badToken(row.method, new CallError(row.error));
    assert.equal(`${failure.code}: ${failure.message}`, row.expected);
  }
});

test('token shapes, scopes and the manifest match', () => {
  for (const row of api.check_token_shape) {
    let message = null;
    try {
      checkTokenShape(row.bot, row.app);
    } catch (error) {
      assert.ok(error instanceof Coded);
      message = `${error.code}: ${error.message}`;
    }
    assert.equal(message, row.expected, JSON.stringify([row.bot, row.app]));
  }
  for (const row of api.unapproved_scopes) {
    assert.deepEqual(unapprovedScopes(row.granted), row.expected, JSON.stringify(row.granted));
  }
  for (const row of api.scope_locked) {
    assert.equal(scopeLocked(row.unapproved), row.expected);
  }
  for (const row of api.manifest) {
    assert.equal(manifestFor(row.name, row.description), row.expected);
  }
  assert.deepEqual(SCOPES, api.constants.scopes);
  assert.deepEqual(EVENTS, api.constants.events);
  assert.deepEqual(TOLERATED_SCOPES, api.constants.tolerated_scopes);
  assert.equal(DEFAULT_APP_NAME, api.constants.default_app_name);
  assert.equal(DEFAULT_APP_DESCRIPTION, api.constants.default_app_description);
  assert.equal(BOT_PREFIX, 'xoxb-');
  assert.equal(APP_PREFIX, 'xapp-');
  const approved = JSON.parse(manifestFor());
  assert.deepEqual(approved.oauth_config.scopes.bot, SCOPES);
  assert.equal(approved.settings.socket_mode_enabled, true);
});

test('file uploads follow Slack external flow', () => {
  for (const row of api.upload_form) {
    assert.deepEqual(uploadForm(row.name, row.length), row.expected);
  }
  for (const row of api.slot_of) {
    let result;
    try {
      const slot = slotOf(row.value);
      result = { id: slot.id, url: slot.url };
    } catch (error) {
      assert.ok(error instanceof CallError);
      result = { error: describe('files.getUploadURLExternal', error.detail) };
    }
    assert.deepEqual(result, row.expected, JSON.stringify(row.value));
  }
  for (const row of api.complete_payload) {
    assert.deepEqual(completePayload(row.input.files, row.input.channel, row.input.thread_ts, row.input.comment), row.expected);
  }
  assert.equal(FILES_SCOPE_NOTE, api.constants.files_scope_note);
  assert.equal(FILES_GONE_NOTE, api.constants.files_gone_note);
});

test('channel lists merge, sort and cap the same way', () => {
  for (const row of api.merge_channels) {
    assert.deepEqual(mergeChannels(row.joined, row.listed), row.expected);
  }
  const cap = api.merge_channels_cap;
  const channel = (id, name, member) => ({ id, name, is_private: false, is_member: member });
  const listed = Array.from({ length: cap.listed_count }, (_, index) => channel(`C${String(index).padStart(7, '0')}`, `aa-${String(index).padStart(4, '0')}`, false));
  listed.push(channel(cap.listed_extra.id, cap.listed_extra.name, false));
  const merged = mergeChannels(
    cap.joined.map((item) => channel(item.id, item.name, true)),
    listed,
  );
  assert.equal(merged.length, cap.expected_len);
  assert.equal(merged.some((item) => item.id === 'C0JOINED' && item.is_member), cap.expected_joined_kept);
  assert.equal(merged.filter((item) => item.id === 'C0BOTH01').length, cap.expected_both_once);
  assert.equal(merged.find((item) => item.id === 'C0BOTH01').is_member, cap.expected_both_member);
  assert.equal(CHANNEL_CAP, cap.cap);
  assert.equal(CHANNEL_CAP, api.constants.channel_cap);
  assert.equal(NAME_CACHE, api.constants.name_cache);
});

test('the socket timing and error text match', () => {
  for (const row of api.went_quiet) {
    assert.equal(wentQuiet(row.since_ms, row.idle_ms), row.expected);
  }
  for (const row of api.socket_error) {
    assert.equal(socketError(row.text, row.url), row.expected, row.text);
  }
  assert.deepEqual(BACKOFF_MS, api.constants.backoff_ms);
  assert.equal(IDLE_TIMEOUT_MS, api.constants.idle_timeout_ms);
  assert.equal(PING_EVERY_MS, api.constants.ping_every_ms);
});

test('secrets never survive redaction', () => {
  for (const row of api.redaction) {
    const output = redact(row.text, 400);
    for (const secret of row.forbidden) {
      assert.ok(!output.includes(secret), `${secret} survived in ${output}`);
    }
  }
  assert.ok(!redact('wss://wss-primary.slack.com/link/?ticket=abc&app_id=A1 failed', 200).includes('ticket'));
  assert.ok(!redact('token cmc_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef used', 200).includes('cmc_0123'));
});
