import crypto from 'node:crypto';

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function oid(dotted) {
  const numbers = dotted.split('.').map(Number);
  const bytes = [numbers[0] * 40 + numbers[1]];
  for (const value of numbers.slice(2)) {
    const group = [value % 128];
    for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) group.unshift((rest % 128) | 0x80);
    bytes.push(...group);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(bytes) {
  const body = bytes[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return tlv(0x02, body);
}

function utcTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function pem(label, der) {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

const sequence = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const bool = tlv(0x01, Buffer.from([0xff]));

export const TEST_HOST = 'slack-test.example';

export function selfSigned() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const name = sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(TEST_HOST)))));
  const altNames = sequence(
    tlv(0x82, Buffer.from(TEST_HOST)),
    tlv(0x82, Buffer.from('localhost')),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const extensions = sequence(
    sequence(oid('2.5.29.17'), tlv(0x04, altNames)),
    sequence(oid('2.5.29.19'), bool, tlv(0x04, sequence(bool))),
  );
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const now = Date.now();
  const details = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(utcTime(new Date(now - 86400000)), utcTime(new Date(now + 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, extensions),
  );
  const signature = crypto.sign('sha256', details, privateKey);
  const certificate = sequence(details, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', certificate),
  };
}
