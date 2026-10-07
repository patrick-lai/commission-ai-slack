import { MAX_FILES, MAX_TEXT_CHARS, idShaped, takeChars, trim, tsShaped } from './text.js';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value) {
  return typeof value === 'string' ? value : undefined;
}

export function fileOf(value) {
  if (!isObject(value)) {
    return null;
  }
  const id = stringOf(value.id);
  if (id === undefined) {
    return null;
  }
  if (value.mode === 'tombstone' || value.file_access === 'access_denied') {
    return null;
  }
  const text = (key) => trim(stringOf(value[key]) ?? '');
  let url = '';
  if (value.file_access !== 'check_file_info') {
    url = text('url_private_download') !== '' ? text('url_private_download') : text('url_private');
  }
  let name = text('name');
  if (name === '') {
    name = text('title');
  }
  if (name === '') {
    name = 'file';
  }
  const size = Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0;
  return { id, name, mime: text('mimetype'), url, size };
}

export function parseEvent(payload, botUser) {
  if (!isObject(payload) || !isObject(payload.event)) {
    return null;
  }
  const event = payload.event;
  const kind = stringOf(event.type);
  if (kind === undefined) {
    return null;
  }
  const subtype = stringOf(event.subtype);
  const message = kind === 'message' && (subtype === undefined || subtype === 'file_share' || subtype === 'thread_broadcast');
  if (!message && kind !== 'app_mention') {
    return null;
  }
  if ('bot_id' in event || subtype === 'bot_message') {
    return null;
  }
  const user = stringOf(event.user);
  const channel = stringOf(event.channel);
  const ts = stringOf(event.ts);
  if (user === undefined || channel === undefined || ts === undefined) {
    return null;
  }
  if (!idShaped(user) || !idShaped(channel) || !tsShaped(ts) || (botUser !== '' && user === botUser)) {
    return null;
  }
  const threadTs = stringOf(event.thread_ts);
  const thread = threadTs !== undefined && threadTs !== ts && tsShaped(threadTs) ? threadTs : null;
  const text = takeChars(stringOf(event.text) ?? '', MAX_TEXT_CHARS);
  const mentioned = kind === 'app_mention' || (botUser !== '' && text.includes(`<@${botUser}>`));
  const files = Array.isArray(event.files) ? event.files.map(fileOf).filter((file) => file !== null).slice(0, MAX_FILES * 2) : [];
  const workspace = stringOf(payload.team_id) ?? stringOf(event.team) ?? '';
  return {
    event_id: stringOf(payload.event_id) ?? null,
    client_msg_id: stringOf(event.client_msg_id) ?? null,
    message: {
      provider: 'slack',
      workspace,
      conversation: channel,
      thread,
      sender_id: user,
      sender_name: null,
      text,
      id: ts,
      files,
      mentioned,
    },
  };
}

export function eventKeys(event) {
  const keys = [];
  if (event.event_id !== null) {
    keys.push(`event:${event.event_id}`);
  }
  if (event.client_msg_id !== null) {
    keys.push(`client:${event.client_msg_id}`);
  }
  keys.push(`ts:${event.message.conversation}:${event.message.id}`);
  return keys;
}
