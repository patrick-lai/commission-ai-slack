import { trim } from './text.js';

export const BOT_PREFIX = 'xoxb-';
export const APP_PREFIX = 'xapp-';
export const SCOPES = ['app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'commands', 'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write', 'users:read', 'users:read.email'];
export const EVENTS = ['app_mention', 'message.im'];
export const TOLERATED_SCOPES = ['assistant:write', 'files:read', 'files:write'];
export const DEFAULT_APP_NAME = 'CommissionAI';
export const DEFAULT_APP_DESCRIPTION = 'Passes messages that mention it to your CommissionAI team and answers in the thread when useful.';

export class Coded extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Coded';
    this.code = code;
  }
}

function tokenShaped(token, prefix) {
  return token.startsWith(prefix) && token.length >= 20 && token.length <= 400 && /^[A-Za-z0-9_.-]+$/.test(token);
}

export function checkTokenShape(bot, app) {
  if (!tokenShaped(trim(bot), BOT_PREFIX)) {
    throw new Coded('bridge.bad_token', 'The bot token starts with xoxb-. Copy the Bot User OAuth Token from OAuth & Permissions in your Slack app');
  }
  if (!tokenShaped(trim(app), APP_PREFIX)) {
    throw new Coded('bridge.bad_token', 'The app token starts with xapp-. Create one under Basic Information > App-Level Tokens with the connections:write scope');
  }
}

export function unapprovedScopes(granted) {
  return granted
    .split(',')
    .map(trim)
    .filter((scope) => scope !== '' && !SCOPES.includes(scope) && !TOLERATED_SCOPES.includes(scope));
}

export function scopeLocked(unapproved) {
  return `The Slack app has permissions outside the approved list (${unapproved.join(', ')}): create the app again from the CommissionAI manifest and reinstall it`;
}

function sorted(value) {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

export function manifestFor(name = DEFAULT_APP_NAME, description = DEFAULT_APP_DESCRIPTION) {
  return JSON.stringify(
    sorted({
      display_information: { name, description },
      features: { bot_user: { display_name: name, always_online: true } },
      oauth_config: { scopes: { bot: SCOPES } },
      settings: {
        event_subscriptions: { bot_events: EVENTS },
        interactivity: { is_enabled: false },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    }),
  );
}
