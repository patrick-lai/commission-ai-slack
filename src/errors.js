const AUTH_CODES = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'not_allowed_token_type', 'invalid_token'];
const APP_TOKEN_CODES = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'missing_scope', 'account_inactive', 'invalid_token'];
const BOT_TOKEN_CODES = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'invalid_token'];

export class CallError extends Error {
  constructor(detail) {
    super(describe('', detail));
    this.name = 'CallError';
    this.detail = detail;
  }
}

export function apiError(code, needed = null) {
  return { kind: 'api', code, needed };
}

export function limited(seconds) {
  return { kind: 'limited', seconds };
}

export function status(code) {
  return { kind: 'status', status: code };
}

export function unsent(text) {
  return { kind: 'unsent', text };
}

export function unsure(text) {
  return { kind: 'unsure', text };
}

export function isAuth(error) {
  return error.kind === 'api' && AUTH_CODES.includes(error.code);
}

export function errorCode(error) {
  return error.kind === 'api' ? error.code : null;
}

export function filesUnavailable(error) {
  return error.kind === 'api' && (error.code === 'missing_scope' || error.code === 'not_allowed');
}

export function describe(method, error) {
  switch (error.kind) {
    case 'api': {
      const { code, needed } = error;
      if (method === 'apps.connections.open' && APP_TOKEN_CODES.includes(code)) {
        return 'Slack rejected the app token: regenerate it under Basic Information > App-Level Tokens (it needs the connections:write scope)';
      }
      if (BOT_TOKEN_CODES.includes(code)) {
        return 'Slack rejected the bot token: reinstall the app and copy the Bot User OAuth Token (xoxb-) again';
      }
      if (code === 'missing_scope') {
        const detail = needed !== null && needed !== undefined ? ` (${needed})` : '';
        return `The Slack app is missing a permission${detail}: update the app from the manifest and reinstall it`;
      }
      if ((method === 'chat.postMessage' || method === 'files.completeUploadExternal') && (code === 'channel_not_found' || code === 'not_in_channel')) {
        return 'The Slack app is not in that channel: type /invite in that channel and pick the app';
      }
      if (code === 'is_archived') {
        return 'That Slack channel is archived';
      }
      if (method === 'conversations.join' && (code === 'method_not_supported_for_channel_type' || code === 'channel_not_found')) {
        return "The bot can't join that channel on its own: type /invite in that channel and pick the app";
      }
      if (code === 'ratelimited') {
        return 'Slack asked us to slow down';
      }
      return `Slack answered ${code}`;
    }
    case 'limited':
      return `Slack asked us to slow down. Try again in ${error.seconds}s`;
    case 'status':
      return `Slack answered with HTTP ${error.status}`;
    case 'unsent':
    case 'unsure':
      return `Can't reach Slack (${error.text})`;
    default:
      return 'Slack could not be reached';
  }
}
