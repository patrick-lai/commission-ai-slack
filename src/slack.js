import { CallError, apiError, describe, limited, status, unsent, unsure } from './errors.js';
import { NetError, request } from './net.js';
import { redact } from './redact.js';
import { Coded, checkTokenShape, scopeLocked, unapprovedScopes } from './scopes.js';
import { allowedFileUrl, codeUnitCompare, escapeText, trim } from './text.js';
import { fileOf } from './events.js';

export const DEFAULT_API = 'https://slack.com/api/';
export const CHANNEL_CAP = 1000;
export const LISTED_PAGES = 4;
export const NAME_CACHE = 500;
const API_TIMEOUT_MS = 20000;
const FILE_TIMEOUT_MS = 60000;
const UPLOAD_TIMEOUT_MS = 180000;
const CONNECT_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

function transport(error) {
  if (error instanceof NetError) {
    return error.kind === 'unsent' ? unsent(error.text) : unsure(error.text);
  }
  return unsure(redact(error instanceof Error ? error.message : String(error), 160));
}

function channelOf(value) {
  if (typeof value !== 'object' || value === null || typeof value.id !== 'string') {
    return null;
  }
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    is_private: value.is_private === true,
    is_member: value.is_member === true,
  };
}

export function mergeChannels(joined, listed) {
  const seen = new Set(joined.map((channel) => channel.id));
  const channels = [...joined];
  for (const channel of listed) {
    if (channels.length >= CHANNEL_CAP) {
      break;
    }
    if (!seen.has(channel.id)) {
      seen.add(channel.id);
      channels.push(channel);
    }
  }
  return channels
    .map((channel, index) => ({ channel, index, key: channel.name.toLowerCase() }))
    .sort((left, right) => codeUnitCompare(left.key, right.key) || left.index - right.index)
    .map((entry) => entry.channel);
}

export function uploadForm(name, length) {
  return [
    ['filename', name],
    ['length', String(length)],
  ];
}

export function slotOf(value, allow = allowedFileUrl) {
  const text = (key) => trim(typeof value[key] === 'string' ? value[key] : '');
  const id = text('file_id');
  const url = text('upload_url');
  let address = null;
  try {
    address = new URL(url);
  } catch {
    address = null;
  }
  if (id === '' || address === null || !allow(address)) {
    throw new CallError(unsure('Slack did not return a usable upload address'));
  }
  return { id, url };
}

export function completePayload(files, channel, threadTs, comment) {
  return { files: files.map(([id, title]) => ({ id, title })), channel_id: channel, thread_ts: threadTs, initial_comment: comment };
}

export class Slack {
  constructor(options = {}) {
    this.apiBase = options.apiBase ?? DEFAULT_API;
    this.env = options.env ?? process.env;
    this.userAgent = options.userAgent ?? 'commission-ai-slack';
    this.allowFile = options.allowFile ?? allowedFileUrl;
    this.names = new Map();
  }

  async callScoped(token, method, body) {
    const headers = { authorization: `Bearer ${token}`, 'user-agent': this.userAgent, accept: 'application/json' };
    let payload;
    if (body?.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body.form).toString();
    } else if (body?.json) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    }
    let response;
    try {
      response = await request({ url: `${this.apiBase}${method}`, method: 'POST', headers, body: payload, timeoutMs: API_TIMEOUT_MS, connectTimeoutMs: CONNECT_TIMEOUT_MS, redirect: null, env: this.env });
    } catch (error) {
      throw new CallError(transport(error));
    }
    const scopes = response.headers['x-oauth-scopes'] ?? null;
    if (response.status === 429) {
      const parsed = /^\d+$/.test(trim(response.headers['retry-after'] ?? '')) ? Number(trim(response.headers['retry-after'])) : 30;
      throw new CallError(limited(Math.min(Math.max(parsed, 1), 3600)));
    }
    if (response.status < 200 || response.status > 299) {
      throw new CallError(status(response.status));
    }
    let value;
    try {
      value = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new CallError(unsure('the response could not be read'));
    }
    if (typeof value === 'object' && value !== null && value.ok === true) {
      return { value, scopes };
    }
    const code = typeof value?.error === 'string' ? value.error : 'unknown_error';
    throw new CallError(apiError(code, typeof value?.needed === 'string' ? value.needed : null));
  }

  async call(token, method, body) {
    return (await this.callScoped(token, method, body)).value;
  }

  async authTest(bot) {
    const { value, scopes } = await this.callScoped(bot, 'auth.test');
    const text = (key) => (typeof value[key] === 'string' ? value[key] : '');
    return { user_id: text('user_id'), bot: text('user'), team_id: text('team_id'), team: text('team'), unapproved: scopes === null ? [] : unapprovedScopes(scopes) };
  }

  async connectionsOpen(app) {
    const value = await this.call(app, 'apps.connections.open');
    if (typeof value.url !== 'string') {
      throw new CallError(unsure('Slack did not return a socket address'));
    }
    return value.url;
  }

  async verify(bot, app) {
    checkTokenShape(bot, app);
    let identity;
    try {
      identity = await this.authTest(trim(bot));
    } catch (error) {
      throw badToken('auth.test', error);
    }
    if (identity.unapproved.length > 0) {
      throw new Coded('bridge.scope_locked', scopeLocked(identity.unapproved));
    }
    try {
      await this.connectionsOpen(trim(app));
    } catch (error) {
      throw badToken('apps.connections.open', error);
    }
    return identity;
  }

  async channelInfo(bot, channel) {
    const value = await this.call(bot, 'conversations.info', { form: [['channel', channel]] });
    const facts = channelOf(value.channel);
    if (facts === null) {
      throw new CallError(unsure('Slack did not describe that channel'));
    }
    return facts;
  }

  async joinChannel(bot, channel) {
    await this.call(bot, 'conversations.join', { form: [['channel', channel]] });
  }

  async openDirect(bot, user) {
    const value = await this.call(bot, 'conversations.open', { form: [['users', user]] });
    const id = value.channel?.id;
    if (typeof id !== 'string') {
      throw new CallError(unsure('Slack did not open that direct message'));
    }
    return id;
  }

  async channelPages(bot, method, pages) {
    const channels = [];
    let cursor = '';
    for (let page = 0; page < pages; page += 1) {
      const form = [
        ['types', 'public_channel,private_channel'],
        ['exclude_archived', 'true'],
        ['limit', '200'],
      ];
      if (cursor !== '') {
        form.push(['cursor', cursor]);
      }
      const value = await this.call(bot, method, { form });
      if (Array.isArray(value.channels)) {
        for (const found of value.channels) {
          const facts = channelOf(found);
          if (facts !== null && channels.length < CHANNEL_CAP) {
            channels.push(facts);
          }
        }
      }
      const next = value.response_metadata?.next_cursor;
      cursor = typeof next === 'string' ? next : '';
      if (cursor === '' || channels.length >= CHANNEL_CAP) {
        break;
      }
    }
    return channels;
  }

  async joinedChannels(bot) {
    const joined = await this.channelPages(bot, 'users.conversations', Math.floor(CHANNEL_CAP / 200) + 1);
    return joined.map((channel) => ({ ...channel, is_member: true }));
  }

  async listChannels(bot) {
    const joined = await this.joinedChannels(bot);
    let listed;
    try {
      listed = await this.channelPages(bot, 'conversations.list', LISTED_PAGES);
    } catch (error) {
      if (joined.length === 0 || !(error instanceof CallError)) {
        throw error;
      }
      listed = [];
    }
    return mergeChannels(joined, listed);
  }

  async userName(bot, id) {
    const known = this.names.get(id);
    if (known !== undefined) {
      return known;
    }
    if (bot === '') {
      return null;
    }
    let value;
    try {
      value = await this.call(bot, 'users.info', { form: [['user', id]] });
    } catch (error) {
      if (error instanceof CallError) {
        return null;
      }
      throw error;
    }
    const user = value.user;
    if (typeof user !== 'object' || user === null) {
      return null;
    }
    const pick = (...path) => {
      let found = user;
      for (const key of path) {
        found = typeof found === 'object' && found !== null ? found[key] : undefined;
      }
      return typeof found === 'string' && trim(found) !== '' ? trim(found) : null;
    };
    const name = pick('profile', 'display_name') ?? pick('real_name') ?? pick('profile', 'real_name') ?? pick('name');
    if (name === null) {
      return null;
    }
    if (this.names.size >= NAME_CACHE) {
      this.names.clear();
    }
    this.names.set(id, name);
    return name;
  }

  async fileInfo(bot, id) {
    const value = await this.call(bot, 'files.info', { form: [['file', id]] });
    const file = fileOf(value.file);
    if (file === null || file.url === '') {
      throw new CallError(unsure('Slack did not return the file'));
    }
    return file;
  }

  async postMessage(bot, channel, threadTs, text) {
    const json = { channel, text, mrkdwn: true, parse: 'none', unfurl_links: false, unfurl_media: false };
    if (threadTs !== null && threadTs !== undefined) {
      json.thread_ts = threadTs;
    }
    await this.call(bot, 'chat.postMessage', { json });
  }

  async uploadSlot(bot, name, length) {
    const value = await this.call(bot, 'files.getUploadURLExternal', { form: uploadForm(name, length) });
    return slotOf(value, this.allowFile);
  }

  async uploadBytes(url, bytes) {
    let response;
    try {
      response = await request({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'user-agent': this.userAgent },
        body: bytes,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        redirect: { max: MAX_REDIRECTS, allow: this.allowFile },
        env: this.env,
      });
    } catch (error) {
      throw new CallError(transport(error));
    }
    if (response.status < 200 || response.status > 299) {
      throw new CallError(status(response.status));
    }
  }

  async completeUpload(bot, payload) {
    await this.call(bot, 'files.completeUploadExternal', { json: payload });
  }

  async download(bot, file, cap) {
    let url;
    try {
      url = new URL(file.url);
    } catch {
      return { skip: 'failed' };
    }
    if (!this.allowFile(url)) {
      return { skip: 'failed' };
    }
    let response;
    try {
      response = await request({
        url,
        method: 'GET',
        headers: { authorization: `Bearer ${bot}`, 'user-agent': this.userAgent },
        timeoutMs: FILE_TIMEOUT_MS,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        maxBytes: cap,
        redirect: { max: MAX_REDIRECTS, allow: this.allowFile },
        env: this.env,
      });
    } catch (error) {
      return { skip: error instanceof NetError && error.kind === 'too_large' ? 'too_large' : 'failed' };
    }
    if (response.status >= 300 && response.status < 400) {
      return { skip: 'no_access' };
    }
    if (response.status === 401 || response.status === 403) {
      return { skip: 'no_access' };
    }
    if (response.status < 200 || response.status > 299 || !this.allowFile(response.url)) {
      return { skip: 'failed' };
    }
    const html = (response.headers['content-type'] ?? '').toLowerCase().startsWith('text/html');
    if (html && file.mime.toLowerCase() !== 'text/html') {
      return { skip: 'no_access' };
    }
    return { bytes: response.body };
  }

  async send(bot, channel, threadTs, text) {
    await this.postMessage(bot, channel, threadTs, escapeText(text));
  }
}

export function badToken(method, error) {
  if (!(error instanceof CallError)) {
    throw error;
  }
  const unreachable = ['unsent', 'unsure', 'limited', 'status'].includes(error.detail.kind);
  return new Coded(unreachable ? 'bridge.slack_unreachable' : 'bridge.bad_token', describe(method, error.detail));
}
