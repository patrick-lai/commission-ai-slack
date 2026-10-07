const CREDENTIAL = /(?:xox[abp]-|xapp-|sk-|ghp_|gho_|cmh_|cmc_)[A-Za-z0-9_.-]*/gi;
const BEARER = /\bBearer\s+\S+/gi;
const QUERY = /\?[^\s"'<>]*/g;
const LONG_SECRET = /\b(?=[A-Za-z0-9_.-]*\d)(?=[A-Za-z0-9_.-]*[A-Z])[A-Za-z0-9_.-]{41,}\b/g;

export function redact(text, limit) {
  const cleaned = String(text)
    .replace(BEARER, 'Bearer [redacted]')
    .replace(CREDENTIAL, '[redacted]')
    .replace(QUERY, '')
    .replace(LONG_SECRET, '[redacted]');
  return Array.from(cleaned).slice(0, limit).join('');
}
