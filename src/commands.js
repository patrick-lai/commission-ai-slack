import { CallError } from './errors.js';
import { prepareMessage } from './prepare.js';
import { Coded } from './scopes.js';

function failure(error) {
  return { ok: false, value: null, error };
}

function notConfigured() {
  return failure({ kind: 'verify', code: 'bridge.not_configured', message: 'Add the Slack bot token and app token first' });
}

async function perform(context, call) {
  const { slack } = context;
  if (call.kind === 'verify') {
    const identity = await slack.verify(call.bot_token, call.app_token);
    return { kind: 'verified', team: identity.team };
  }
  const bot = context.credentials?.bot_token ?? '';
  if (bot === '') {
    return null;
  }
  switch (call.kind) {
    case 'channel_info':
      return { kind: 'channel', channel: await slack.channelInfo(bot, call.channel) };
    case 'join_channel':
      await slack.joinChannel(bot, call.channel);
      return { kind: 'done' };
    case 'open_direct':
      return { kind: 'direct', conversation: await slack.openDirect(bot, call.user) };
    case 'user_name':
      return { kind: 'name', name: await slack.userName(bot, call.user) };
    case 'joined_channels':
      return { kind: 'channels', channels: await slack.joinedChannels(bot) };
    case 'list_channels':
      return { kind: 'channels', channels: await slack.listChannels(bot) };
    case 'post_message':
      await slack.postMessage(bot, call.channel, call.thread_ts ?? null, call.text);
      return { kind: 'done' };
    case 'prepare':
      return { kind: 'prepared', prepared: await prepareMessage({ slack, bot, botUser: call.bot_user, daemon: context.daemon }, call.message, call.limits) };
    default:
      return undefined;
  }
}

export async function runCall(context, call) {
  try {
    const value = await perform(context, call);
    if (value === null) {
      return notConfigured();
    }
    if (value === undefined) {
      return failure({ kind: 'verify', code: 'connector.command_unknown', message: 'The Slack connector does not know that request' });
    }
    return { ok: true, value, error: null };
  } catch (error) {
    if (error instanceof CallError) {
      return failure(error.detail);
    }
    if (error instanceof Coded) {
      return failure({ kind: 'verify', code: error.code, message: error.message });
    }
    return failure({ kind: 'unsure', text: 'the Slack connector stopped unexpectedly' });
  }
}
