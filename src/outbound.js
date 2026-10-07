import { CallError, describe, filesUnavailable } from './errors.js';
import { completePayload } from './slack.js';
import { escapeText } from './text.js';

export const FILES_SCOPE_NOTE = '(attachments could not be sent: the Slack app is limited to its approved permissions, which do not include file uploads)';
export const FILES_GONE_NOTE = '(attachments could not be sent: the files are no longer available)';
const RETRYABLE_CODES = ['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'];
const STAGE_METHODS = {
  text: 'chat.postMessage',
  prepare: 'files.getUploadURLExternal',
  upload: 'the file upload',
  complete: 'files.completeUploadExternal',
};

class Settled extends Error {
  constructor(outcome) {
    super(outcome.outcome);
    this.outcome = outcome;
  }
}

export function fallbackText(text, fallback) {
  return `${text}\n${fallback === 'scope' ? FILES_SCOPE_NOTE : FILES_GONE_NOTE}`;
}

export function sentAfter(stage, error) {
  const method = STAGE_METHODS[stage];
  switch (error.kind) {
    case 'limited':
      return { outcome: 'limited', seconds: error.seconds };
    case 'unsent':
      return { outcome: 'retry', detail: `Can't reach Slack (${error.text})` };
    case 'unsure':
    case 'status':
      if (stage === 'prepare') {
        return { outcome: 'retry', detail: describe(method, error) };
      }
      return { outcome: 'unconfirmed', detail: `${describe(method, error)}. Check the thread before sending it again` };
    default: {
      const detail = describe(method, error);
      return RETRYABLE_CODES.includes(error.code) ? { outcome: 'retry', detail } : { outcome: 'failed', detail };
    }
  }
}

async function atStage(stage, work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CallError) {
      throw new Settled(sentAfter(stage, error.detail));
    }
    throw error;
  }
}

async function postFiles(context, row) {
  const { slack, bot, daemon } = context;
  if (row.files.some((file) => typeof file.size !== 'number')) {
    return 'fallback_gone';
  }
  const slots = [];
  for (const file of row.files) {
    try {
      slots.push(await slack.uploadSlot(bot, file.name, file.size));
    } catch (error) {
      if (error instanceof CallError && filesUnavailable(error.detail)) {
        return 'fallback_scope';
      }
      throw error instanceof CallError ? new Settled(sentAfter('prepare', error.detail)) : error;
    }
  }
  for (const [index, file] of row.files.entries()) {
    const found = await daemon.media(file.sha);
    if (found.state === 'error') {
      throw new Settled({ outcome: 'retry', detail: 'CommissionAI could not read the attached files' });
    }
    if (found.state === 'missing' || found.bytes.length !== file.size) {
      return 'fallback_gone';
    }
    await atStage('upload', () => slack.uploadBytes(slots[index].url, found.bytes));
  }
  const uploaded = slots.map((slot, index) => [slot.id, row.files[index].name]);
  const payload = completePayload(uploaded, row.channel, row.thread_ts, escapeText(row.text));
  try {
    await slack.completeUpload(bot, payload);
  } catch (error) {
    if (error instanceof CallError && filesUnavailable(error.detail)) {
      return 'fallback_scope';
    }
    throw error instanceof CallError ? new Settled(sentAfter('complete', error.detail)) : error;
  }
  return 'attached';
}

async function post(context, row) {
  const { slack, bot } = context;
  if (row.files.length === 0) {
    await atStage('text', () => slack.send(bot, row.channel, row.thread_ts, row.text));
    return 'text';
  }
  const delivery = await postFiles(context, row);
  if (delivery === 'attached') {
    return delivery;
  }
  const fallback = delivery === 'fallback_scope' ? 'scope' : 'gone';
  await atStage('text', () => slack.send(bot, row.channel, row.thread_ts, fallbackText(row.text, fallback)));
  return delivery;
}

export async function deliverRow(context, row) {
  try {
    return { outcome: 'delivered', delivery: await post(context, row) };
  } catch (error) {
    if (error instanceof Settled) {
      return error.outcome;
    }
    return { outcome: 'unconfirmed', detail: 'The Slack connector stopped unexpectedly. Check the thread before sending it again' };
  }
}
