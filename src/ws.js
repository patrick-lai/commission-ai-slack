import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { NetError, isAbortSignal, openStream } from './net.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const USER_AGENT = 'commission-ai-slack';
const MAX_HANDSHAKE_BYTES = 16384;
const DEFAULT_MAX_MESSAGE_BYTES = 1048576;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
const MAX_CONTROL_BYTES = 125;
const EMPTY = Buffer.alloc(0);
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})/;
const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
const KNOWN_OPCODES = new Set(Object.values(OPCODE));

export class ProtocolError extends Error {
  constructor(closeCode, detail) {
    super(detail);
    this.name = 'ProtocolError';
    this.closeCode = closeCode;
    this.detail = detail;
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return EMPTY;
}

function resolveMask(mask) {
  if (mask === true) return crypto.randomBytes(4);
  if (Buffer.isBuffer(mask) && mask.length === 4) return mask;
  return null;
}

function applyMask(source, key) {
  const out = Buffer.allocUnsafe(source.length);
  for (let index = 0; index < source.length; index += 1) out[index] = source[index] ^ key[index & 3];
  return out;
}

export function encodeFrame({ opcode, payload = EMPTY, mask = null, fin = true } = {}) {
  const body = toBuffer(payload);
  const key = resolveMask(mask);
  let head;
  if (body.length < 126) {
    head = Buffer.alloc(2);
    head[1] = body.length;
  } else if (body.length <= 0xffff) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  head[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (key === null) return Buffer.concat([head, body]);
  head[1] |= 0x80;
  return Buffer.concat([head, key, applyMask(body, key)]);
}

function readHead(buffer, offset, options) {
  const available = buffer.length - offset;
  if (available < 2) return { need: 2 };
  const first = buffer[offset];
  const second = buffer[offset + 1];
  if ((first & 0x70) !== 0) throw new ProtocolError(1002, 'reserved bits set');
  const opcode = first & 0x0f;
  if (!KNOWN_OPCODES.has(opcode)) throw new ProtocolError(1002, 'unknown opcode');
  const fin = (first & 0x80) !== 0;
  const masked = (second & 0x80) !== 0;
  if (masked && options.rejectMasked) throw new ProtocolError(1002, 'masked server frame');
  const control = opcode >= 8;
  if (control && !fin) throw new ProtocolError(1002, 'fragmented control frame');
  const marker = second & 0x7f;
  const lengthBytes = marker === 126 ? 2 : marker === 127 ? 8 : 0;
  if (available < 2 + lengthBytes) return { need: 2 + lengthBytes };
  let length = marker;
  if (lengthBytes === 2) {
    length = buffer.readUInt16BE(offset + 2);
  } else if (lengthBytes === 8) {
    const wide = buffer.readBigUInt64BE(offset + 2);
    if (wide >> 63n !== 0n) throw new ProtocolError(1002, 'invalid length');
    if (wide > BigInt(options.maxPayloadBytes)) throw new ProtocolError(1009, 'message too large');
    length = Number(wide);
  }
  if (control && length > MAX_CONTROL_BYTES) throw new ProtocolError(1002, 'oversized control frame');
  if (!control && length > options.maxPayloadBytes) throw new ProtocolError(1009, 'message too large');
  const headerLength = 2 + lengthBytes + (masked ? 4 : 0);
  return { fin, opcode, masked, headerLength, length, total: headerLength + length };
}

export class FrameParser {
  constructor({ maxPayloadBytes = DEFAULT_MAX_MESSAGE_BYTES, rejectMasked = false } = {}) {
    this.options = { maxPayloadBytes, rejectMasked };
    this.chunks = [];
    this.size = 0;
    this.need = 2;
    this.failure = null;
  }

  push(chunk) {
    if (this.failure !== null) throw this.failure;
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size < this.need) return [];
    const buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    const frames = [];
    let offset = 0;
    try {
      for (;;) {
        const head = readHead(buffer, offset, this.options);
        if (head.total === undefined) {
          this.need = head.need;
          break;
        }
        if (buffer.length - offset < head.total) {
          this.need = head.total;
          break;
        }
        const start = offset + head.headerLength;
        const body = buffer.subarray(start, start + head.length);
        const mask = head.masked ? Buffer.from(buffer.subarray(start - 4, start)) : null;
        const payload = mask === null ? Buffer.from(body) : applyMask(body, mask);
        frames.push({ fin: head.fin, opcode: head.opcode, payload, masked: head.masked, mask });
        offset += head.total;
        this.need = 2;
      }
    } catch (error) {
      this.failure = error instanceof ProtocolError ? error : new ProtocolError(1002, 'invalid frame');
      this.chunks = [];
      this.size = 0;
      throw this.failure;
    }
    const rest = buffer.subarray(offset);
    this.chunks = rest.length === 0 ? [] : [rest];
    this.size = rest.length;
    return frames;
  }
}

function sendableCloseCode(code) {
  if (!Number.isInteger(code)) return false;
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

function parseClose(payload) {
  if (payload.length === 0) return { code: 1005, reason: '' };
  if (payload.length === 1) throw new ProtocolError(1002, 'invalid close frame');
  const code = payload.readUInt16BE(0);
  if (!sendableCloseCode(code)) throw new ProtocolError(1002, 'invalid close code');
  try {
    return { code, reason: DECODER.decode(payload.subarray(2)) };
  } catch {
    throw new ProtocolError(1007, 'invalid close reason');
  }
}

function controlPayload(value) {
  const body = toBuffer(value);
  return body.length > MAX_CONTROL_BYTES ? null : body;
}

export class Socket extends EventEmitter {
  #stream;
  #parser;
  #what;
  #maxMessageBytes;
  #closeTimeoutMs;
  #fragmentKind = null;
  #fragments = [];
  #fragmentBytes = 0;
  #closeSent = false;
  #halted = false;
  #dead = false;
  #finished = false;
  #errored = false;
  #closeInfo = null;
  #closeTimer = null;

  constructor(stream, options = {}) {
    super();
    const { what = 'the server', maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES, closeTimeoutMs, leftover = EMPTY } = options;
    this.#stream = stream;
    this.#what = what;
    this.#maxMessageBytes = maxMessageBytes;
    this.#closeTimeoutMs = typeof closeTimeoutMs === 'number' && closeTimeoutMs > 0 ? closeTimeoutMs : DEFAULT_CLOSE_TIMEOUT_MS;
    this.#parser = new FrameParser({ maxPayloadBytes: maxMessageBytes, rejectMasked: true });
    stream.on('data', (chunk) => this.#onData(chunk));
    stream.on('error', () => this.#onStreamError());
    stream.on('end', () => this.#onEnd());
    stream.on('close', () => this.#finish());
    if (typeof stream.setNoDelay === 'function') stream.setNoDelay(true);
    setImmediate(() => this.#start(leftover));
  }

  sendText(text) {
    if (typeof text !== 'string') return false;
    return this.#send(OPCODE.text, Buffer.from(text, 'utf8'));
  }

  sendPing(payload = EMPTY) {
    const body = controlPayload(payload);
    return body === null ? false : this.#send(OPCODE.ping, body);
  }

  sendPong(payload = EMPTY) {
    const body = controlPayload(payload);
    return body === null ? false : this.#send(OPCODE.pong, body);
  }

  close(code = 1000) {
    if (this.#dead || this.#closeSent || this.#finished) return false;
    const accepted = this.#sendClose(sendableCloseCode(code) ? code : 1000);
    if (accepted) this.#armCloseTimer();
    return accepted;
  }

  terminate() {
    this.#dead = true;
    this.#halted = true;
    this.#stream.destroy();
  }

  #start(leftover) {
    if (this.#stream.destroyed) {
      this.#finish();
      return;
    }
    if (this.#dead || this.#finished) return;
    if (leftover.length > 0) this.#onData(leftover);
    this.#stream.resume();
  }

  #send(opcode, payload) {
    if (this.#dead || this.#closeSent || this.#finished) return false;
    if (this.#stream.destroyed || !this.#stream.writable) return false;
    this.#stream.write(encodeFrame({ opcode, payload, mask: crypto.randomBytes(4) }));
    return true;
  }

  #sendClose(code) {
    if (this.#dead || this.#closeSent || this.#finished) return false;
    if (this.#stream.destroyed || !this.#stream.writable) return false;
    this.#closeSent = true;
    const payload = code === null ? EMPTY : Buffer.from([code >> 8, code & 0xff]);
    this.#stream.write(encodeFrame({ opcode: OPCODE.close, payload, mask: crypto.randomBytes(4) }));
    return true;
  }

  #armCloseTimer() {
    if (this.#closeTimer !== null) return;
    this.#closeTimer = setTimeout(() => this.#stream.destroy(), this.#closeTimeoutMs);
    this.#closeTimer.unref();
  }

  #emitError(error) {
    if (this.#errored) return;
    this.#errored = true;
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  #fail(code, text) {
    if (this.#halted) return;
    this.#halted = true;
    this.#closeInfo = { code, reason: '', clean: false };
    const error = new NetError('unsure', text);
    error.closeCode = code;
    this.#emitError(error);
    this.#sendClose(code);
    this.#armCloseTimer();
  }

  #protocolFailure(error) {
    const code = error instanceof ProtocolError ? error.closeCode : 1002;
    const detail = error instanceof ProtocolError ? error.detail : 'invalid frame';
    if (code === 1009) {
      this.#fail(code, `${this.#what} sent a message larger than the limit`);
      return;
    }
    this.#fail(code, `${this.#what} sent data that is not valid WebSocket (${detail})`);
  }

  #onStreamError() {
    if (this.#closeInfo !== null && this.#closeInfo.clean) return;
    this.#emitError(new NetError('unsure', `The connection to ${this.#what} was lost`));
  }

  #onEnd() {
    if (!this.#stream.destroyed) this.#stream.end();
  }

  #finish() {
    if (this.#finished) return;
    this.#finished = true;
    this.#dead = true;
    this.#halted = true;
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    const info = this.#closeInfo ?? { code: 1006, reason: '', clean: false };
    this.emit('close', { code: info.code, reason: info.reason, clean: info.clean });
  }

  #onData(chunk) {
    if (this.#halted) return;
    let frames;
    try {
      frames = this.#parser.push(chunk);
    } catch (error) {
      this.#protocolFailure(error);
      return;
    }
    for (const frame of frames) {
      if (this.#halted) return;
      this.#onFrame(frame);
    }
  }

  #onFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.close:
        this.#onCloseFrame(frame.payload);
        return;
      case OPCODE.ping:
        this.emit('ping', frame.payload);
        return;
      case OPCODE.pong:
        this.emit('pong', frame.payload);
        return;
      case OPCODE.continuation:
        this.#onContinuation(frame);
        return;
      default:
        this.#onDataFrame(frame);
    }
  }

  #onCloseFrame(payload) {
    let info;
    try {
      info = parseClose(payload);
    } catch (error) {
      this.#protocolFailure(error);
      return;
    }
    const initiated = this.#closeSent;
    this.#halted = true;
    this.#closeInfo = { code: info.code, reason: info.reason, clean: true };
    if (initiated) {
      this.#stream.destroy();
      return;
    }
    this.#sendClose(info.code === 1005 ? null : info.code);
    this.#stream.end();
    this.#armCloseTimer();
  }

  #onDataFrame(frame) {
    if (this.#fragmentKind !== null) {
      this.#fail(1002, `${this.#what} sent data that is not valid WebSocket (interleaved message)`);
      return;
    }
    if (frame.fin) {
      this.#deliver(frame.opcode, [frame.payload]);
      return;
    }
    this.#fragmentKind = frame.opcode;
    this.#fragments = frame.opcode === OPCODE.text ? [frame.payload] : [];
    this.#fragmentBytes = frame.payload.length;
  }

  #onContinuation(frame) {
    if (this.#fragmentKind === null) {
      this.#fail(1002, `${this.#what} sent data that is not valid WebSocket (unexpected continuation)`);
      return;
    }
    this.#fragmentBytes += frame.payload.length;
    if (this.#fragmentBytes > this.#maxMessageBytes) {
      this.#fail(1009, `${this.#what} sent a message larger than the limit`);
      return;
    }
    if (this.#fragmentKind === OPCODE.text) this.#fragments.push(frame.payload);
    if (!frame.fin) return;
    const kind = this.#fragmentKind;
    const parts = this.#fragments;
    this.#fragmentKind = null;
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#deliver(kind, parts);
  }

  #deliver(opcode, parts) {
    if (opcode !== OPCODE.text) return;
    let text;
    try {
      text = DECODER.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
    } catch {
      this.#fail(1007, `${this.#what} sent text that is not valid UTF-8`);
      return;
    }
    this.emit('message', text);
  }
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

function parseHandshake(text) {
  const lines = text.split('\r\n');
  const match = STATUS_LINE.exec(lines[0] ?? '');
  if (match === null) return null;
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { status: Number(match[1]), headers };
}

function hasToken(value, token) {
  return typeof value === 'string' && value.split(',').some((part) => part.trim().toLowerCase() === token);
}

function handshake(stream, url, plan) {
  const { what, timeoutMs, signal } = plan;
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expected = acceptKey(key);
    const received = [];
    let receivedBytes = 0;
    let settled = false;
    let written = false;

    const timer = setTimeout(() => fail(new NetError('unsure', `${what} didn't answer in time`)), timeoutMs);

    function cleanup() {
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      stream.removeListener('data', onData);
      stream.removeListener('error', onClosed);
      stream.removeListener('close', onClosed);
      stream.removeListener('end', onClosed);
    }

    function fail(error) {
      if (settled) return;
      cleanup();
      error.written = written;
      stream.on('error', () => undefined);
      stream.destroy();
      reject(error);
    }

    function onAbort() {
      fail(new NetError(written ? 'unsure' : 'unsent', 'The connection was cancelled'));
    }

    function onClosed() {
      fail(new NetError('unsure', `${what} closed the connection during the handshake`));
    }

    function invalid() {
      fail(new NetError('unsure', `${what} sent an invalid WebSocket handshake`));
    }

    function onData(chunk) {
      if (settled) return;
      received.push(chunk);
      receivedBytes += chunk.length;
      const buffer = received.length === 1 ? received[0] : Buffer.concat(received, receivedBytes);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (receivedBytes > MAX_HANDSHAKE_BYTES) invalid();
        return;
      }
      if (end + 4 > MAX_HANDSHAKE_BYTES) {
        invalid();
        return;
      }
      const reply = parseHandshake(buffer.subarray(0, end).toString('latin1'));
      if (reply === null) {
        invalid();
        return;
      }
      if (reply.status !== 101) {
        fail(Object.assign(new NetError('unsent', `${what} refused the connection (HTTP ${reply.status})`), { status: reply.status }));
        return;
      }
      const upgrade = reply.headers.get('upgrade');
      const valid =
        typeof upgrade === 'string' &&
        upgrade.trim().toLowerCase() === 'websocket' &&
        hasToken(reply.headers.get('connection'), 'upgrade') &&
        reply.headers.get('sec-websocket-accept') === expected;
      if (!valid) {
        invalid();
        return;
      }
      cleanup();
      stream.pause();
      resolve(Buffer.from(buffer.subarray(end + 4)));
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    stream.on('data', onData);
    stream.on('error', onClosed);
    stream.on('close', onClosed);
    stream.on('end', onClosed);
    const head =
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      `User-Agent: ${USER_AGENT}\r\n\r\n`;
    stream.write(head, () => {
      written = true;
    });
    stream.resume();
  });
}

export async function connect(url, options) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const what = typeof settings.what === 'string' && settings.what !== '' ? settings.what : 'the server';
  const signal = isAbortSignal(settings.signal) ? settings.signal : undefined;
  const connectTimeoutMs =
    typeof settings.connectTimeoutMs === 'number' && settings.connectTimeoutMs > 0
      ? settings.connectTimeoutMs
      : DEFAULT_CONNECT_TIMEOUT_MS;
  let target = null;
  try {
    target = new URL(url instanceof URL ? url.href : url);
  } catch {
    target = null;
  }
  if (target === null || (target.protocol !== 'ws:' && target.protocol !== 'wss:')) {
    throw new NetError('unsent', 'The address is not a WebSocket address');
  }
  if (signal !== undefined && signal.aborted) throw new NetError('unsent', 'The connection was cancelled');
  const startedAt = Date.now();
  const stream = await openStream(target, {
    env: settings.env,
    connectTimeoutMs,
    what,
    tlsOptions: settings.tlsOptions,
    signal,
  });
  const remaining = Math.max(connectTimeoutMs - (Date.now() - startedAt), 1);
  const leftover = await handshake(stream, target, { what, timeoutMs: remaining, signal });
  return new Socket(stream, {
    what,
    leftover,
    maxMessageBytes:
      typeof settings.maxMessageBytes === 'number' && settings.maxMessageBytes > 0
        ? settings.maxMessageBytes
        : DEFAULT_MAX_MESSAGE_BYTES,
    closeTimeoutMs: settings.closeTimeoutMs,
  });
}
