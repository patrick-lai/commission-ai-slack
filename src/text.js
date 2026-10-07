export const MAX_TEXT_CHARS = 20000;
export const MAX_FILES = 10;
export const FILE_MIMES = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/x-har+json', 'application/pdf', 'application/zip'];
const WHITESPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const EDGE_WHITESPACE = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, 'g');
const WHITESPACE_RUN = new RegExp(`[${WHITESPACE}]+`);
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;

export function trim(text) {
  return text.replace(EDGE_WHITESPACE, '');
}

export function splitWhitespace(text) {
  return text.split(WHITESPACE_RUN).filter((word) => word !== '');
}

export function lines(text) {
  if (text === '') {
    return [];
  }
  const parts = text.split('\n');
  const last = parts.pop();
  const terminated = parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  return last === '' ? terminated : [...terminated, last];
}

export function takeChars(text, count) {
  const characters = Array.from(text);
  return characters.length <= count ? text : characters.slice(0, count).join('');
}

export function tsShaped(ts) {
  return /^[0-9.]{1,24}$/.test(ts);
}

export function idShaped(id) {
  return /^[A-Z0-9]{1,24}$/.test(id);
}

function stripLeading(text, character) {
  let start = 0;
  while (text[start] === character) {
    start += 1;
  }
  return text.slice(start);
}

function splitOnce(text, separator) {
  const at = text.indexOf(separator);
  return at < 0 ? null : [text.slice(0, at), text.slice(at + separator.length)];
}

function token(inner, botUser, names) {
  const halves = splitOnce(inner, '|');
  const target = halves ? halves[0] : inner;
  const label = halves && halves[1] !== '' ? halves[1] : null;
  if (target.startsWith('@')) {
    const id = target.slice(1);
    if (botUser !== '' && id === botUser) {
      return '';
    }
    const name = names.get(id);
    if (name !== undefined) {
      return `@${name}`;
    }
    return label !== null ? `@${stripLeading(label, '@')}` : `@${id}`;
  }
  if (target.startsWith('#')) {
    return `#${label ?? target.slice(1)}`;
  }
  if (target.startsWith('!')) {
    const name = target.slice(1).split('^')[0];
    if (name === 'here' || name === 'channel' || name === 'everyone') {
      return `@${name}`;
    }
    return label ?? '';
  }
  if (label !== null && label !== target) {
    return target.startsWith('mailto:') ? label : `${label} (${target})`;
  }
  return target.startsWith('mailto:') ? target.slice('mailto:'.length) : target;
}

export function defang(text) {
  let out = '';
  let previous = null;
  for (const character of text) {
    if (character === '@' && (previous === null || (!ALPHANUMERIC.test(previous) && previous !== '_'))) {
      out += '＠';
    } else {
      out += character;
    }
    previous = character;
  }
  return out.replaceAll('[slack-thread:', '[slack-thread ');
}

export function plain(text, botUser, names) {
  let out = '';
  let rest = text;
  for (;;) {
    const start = rest.indexOf('<');
    if (start < 0) {
      break;
    }
    out += rest.slice(0, start);
    const after = rest.slice(start + 1);
    const end = after.indexOf('>');
    if (end >= 0 && !after.slice(0, end).includes('<')) {
      out += token(after.slice(0, end), botUser, names);
      rest = after.slice(end + 1);
    } else {
      out += '<';
      rest = after;
    }
  }
  out += rest;
  const decoded = out.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const tidy = lines(decoded).map((line) => line.split(' ').filter((word) => word !== '').join(' '));
  return defang(trim(tidy.join('\n')));
}

export function escapeText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function mentionIds(text) {
  const ids = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('<@');
    if (start < 0) {
      break;
    }
    const after = rest.slice(start + 2);
    const end = after.indexOf('>');
    if (end < 0) {
      break;
    }
    const id = after.slice(0, end).split('|')[0];
    if (idShaped(id) && !ids.includes(id)) {
      ids.push(id);
      if (ids.length >= 8) {
        break;
      }
    }
    rest = after.slice(end + 1);
  }
  return ids;
}

export const SKIPS = ['too_large', 'unsupported', 'failed', 'no_access', 'extra'];
const SKIP_REASONS = {
  too_large: 'too large',
  unsupported: 'unsupported type',
  failed: "couldn't be downloaded",
  no_access: "the Slack app can't read files",
  extra: 'too many files',
};

export function skippedNote(skips) {
  const sorted = [...skips].sort((left, right) => SKIPS.indexOf(left) - SKIPS.indexOf(right));
  const parts = [];
  let index = 0;
  while (index < sorted.length) {
    const skip = sorted[index];
    let count = 0;
    while (sorted[index + count] === skip) {
      count += 1;
    }
    parts.push(`${count} ${count === 1 ? 'file' : 'files'} skipped: ${SKIP_REASONS[skip]}`);
    index += count;
  }
  return parts.length === 0 ? '' : `(${parts.join(', ')})`;
}

export function asciiLower(text) {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

export function supportedMime(mime) {
  const lowered = asciiLower(trim(mime));
  return lowered.startsWith('image/') || lowered.startsWith('video/') || FILE_MIMES.includes(lowered);
}

export function allowedFileUrl(candidate) {
  let url;
  try {
    url = candidate instanceof URL ? candidate : new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'files.slack.com') {
    return true;
  }
  const suffix = '.slack-files.com';
  if (!host.endsWith(suffix)) {
    return false;
  }
  const label = host.slice(0, -suffix.length);
  return label !== '' && !label.startsWith('.') && !label.endsWith('.');
}

export function codeUnitCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
