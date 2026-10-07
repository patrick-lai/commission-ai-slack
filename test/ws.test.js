import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { getEventListeners } from 'node:events';
import { NetError } from '../src/net.js';
import { FrameParser, ProtocolError, Socket, connect, encodeFrame } from '../src/ws.js';
import { startWsServer } from './helpers/ws-server.js';
import { startProxy } from './helpers/proxy-server.js';
import { selfSigned } from './helpers/tls-cert.js';

const certificate = selfSigned();
const CONNECT_HEAD = (authority) =>
  `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: commission-ai-slack\r\n\r\n`;

function ignore() {
  return undefined;
}

function deferred() {
  let resolve = ignore;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function collect(emitter, name, count) {
  return new Promise((resolve) => {
    const items = [];
    const handler = (item) => {
      items.push(item);
      if (items.length === count) {
        emitter.removeListener(name, handler);
        resolve(items);
      }
    };
    emitter.on(name, handler);
  });
}

function track(socket) {
  const seen = { order: [], messages: [], errors: [], closes: [], pings: [], pongs: [] };
  socket.on('message', (message) => seen.messages.push(message));
  socket.on('ping', (payload) => seen.pings.push(payload));
  socket.on('pong', (payload) => seen.pongs.push(payload));
  socket.on('error', (error) => {
    seen.errors.push(error);
    seen.order.push('error');
  });
  seen.closed = new Promise((resolve) => {
    socket.on('close', (info) => {
      seen.closes.push(info);
      seen.order.push('close');
      resolve(info);
    });
  });
  return seen;
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('expected a rejection');
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function start(t, serverOptions = {}, clientOptions = {}) {
  const server = await startWsServer(serverOptions);
  t.after(() => server.close());
  const socket = await connect(server.url, { env: {}, what: 'Slack', ...clientOptions });
  t.after(() => socket.terminate());
  return { server, socket, conn: server.connections[0] };
}

function assertSafeError(error) {
  assert.ok(error instanceof NetError);
  const shown = `${error.text}|${error.message}|${JSON.stringify(error)}`;
  for (const secret of ['secret-ticket', '/link', 'ticket=', '127.0.0.1']) {
    assert.ok(!shown.includes(secret), `leaked ${secret}`);
  }
}

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('encodeFrame writes unmasked and masked frames with 7, 16 and 64 bit lengths', () => {
  assert.deepEqual([...encodeFrame({ opcode: 1, payload: 'hi' })], [0x81, 2, 104, 105]);
  assert.deepEqual([...encodeFrame({ opcode: 9, payload: Buffer.alloc(0) })], [0x89, 0]);
  assert.deepEqual([...encodeFrame({ opcode: 1, payload: 'a', fin: false })], [0x01, 1, 97]);
  const mask = Buffer.from([1, 2, 3, 4]);
  assert.deepEqual([...encodeFrame({ opcode: 1, payload: 'hi', mask })], [0x81, 0x82, 1, 2, 3, 4, 104 ^ 1, 105 ^ 2]);
  assert.deepEqual([...encodeFrame({ opcode: 2, payload: Buffer.alloc(125) }).subarray(0, 2)], [0x82, 125]);
  assert.deepEqual([...encodeFrame({ opcode: 2, payload: Buffer.alloc(126) }).subarray(0, 4)], [0x82, 126, 0, 126]);
  assert.deepEqual([...encodeFrame({ opcode: 2, payload: Buffer.alloc(65535) }).subarray(0, 4)], [0x82, 126, 255, 255]);
  const wide = encodeFrame({ opcode: 2, payload: Buffer.alloc(65536) });
  assert.deepEqual([...wide.subarray(0, 10)], [0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.equal(wide.length, 10 + 65536);
  const random = encodeFrame({ opcode: 1, payload: 'x', mask: true });
  assert.equal(random[1], 0x81);
  assert.equal(random.length, 2 + 4 + 1);
});

test('FrameParser round trips frames fed one byte at a time', () => {
  const frames = [
    encodeFrame({ opcode: 1, payload: 'hello', mask: Buffer.from([9, 8, 7, 6]) }),
    encodeFrame({ opcode: 2, payload: Buffer.alloc(200, 7) }),
    encodeFrame({ opcode: 9, payload: 'p' }),
    encodeFrame({ opcode: 2, payload: Buffer.alloc(70000, 1) }),
    encodeFrame({ opcode: 8, payload: Buffer.from([3, 232]) }),
  ];
  const parser = new FrameParser({ maxPayloadBytes: 100000 });
  const parsed = [];
  for (const byte of Buffer.concat(frames)) parsed.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(
    parsed.map((frame) => [frame.opcode, frame.payload.length, frame.masked, frame.fin]),
    [
      [1, 5, true, true],
      [2, 200, false, true],
      [9, 1, false, true],
      [2, 70000, false, true],
      [8, 2, false, true],
    ],
  );
  assert.equal(parsed[0]?.payload.toString(), 'hello');
  assert.deepEqual([...(parsed[0]?.mask ?? [])], [9, 8, 7, 6]);
});

test('FrameParser returns several frames from one chunk and keeps the remainder', () => {
  const parser = new FrameParser();
  const one = encodeFrame({ opcode: 1, payload: 'one' });
  const two = encodeFrame({ opcode: 1, payload: 'two' });
  const three = encodeFrame({ opcode: 1, payload: 'three' });
  const first = parser.push(Buffer.concat([one, two, three.subarray(0, 3)]));
  assert.deepEqual(first.map((frame) => frame.payload.toString()), ['one', 'two']);
  const second = parser.push(three.subarray(3));
  assert.deepEqual(second.map((frame) => frame.payload.toString()), ['three']);
  assert.deepEqual(parser.push(Buffer.alloc(0)), []);
});

test('FrameParser rejects malformed frames with a close code and stays failed', () => {
  const header = (bytes) => Buffer.from(bytes);
  const cases = [
    ['reserved bits', header([0xc1, 0x00]), 1002, {}],
    ['reserved bit 2', header([0xa1, 0x00]), 1002, {}],
    ['unknown opcode 3', header([0x83, 0x00]), 1002, {}],
    ['unknown opcode 11', header([0x8b, 0x00]), 1002, {}],
    ['fragmented ping', header([0x09, 0x00]), 1002, {}],
    ['fragmented close', header([0x08, 0x00]), 1002, {}],
    ['oversized ping', header([0x89, 126, 0, 126]), 1002, {}],
    ['masked when forbidden', encodeFrame({ opcode: 1, payload: 'x', mask: true }), 1002, { rejectMasked: true }],
    ['16 bit over the limit', header([0x81, 126, 0x13, 0x88]), 1009, { maxPayloadBytes: 1000 }],
    ['7 bit over the limit', header([0x81, 50]), 1009, { maxPayloadBytes: 10 }],
    ['64 bit over the limit', header([0x81, 127, 0, 0, 1, 0, 0, 0, 0, 0]), 1009, { maxPayloadBytes: 1000 }],
    ['64 bit with the top bit set', header([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 0]), 1002, {}],
  ];
  for (const [name, bytes, code, options] of cases) {
    const parser = new FrameParser(options);
    assert.throws(
      () => parser.push(bytes),
      (error) => error instanceof ProtocolError && error.closeCode === code,
      name,
    );
    assert.throws(() => parser.push(encodeFrame({ opcode: 1, payload: 'ok' })), ProtocolError, `${name} stays failed`);
  }
});

test('connect performs the handshake and round trips masked text frames', async (t) => {
  const { server, socket, conn } = await start(t, {
    onConnection: (connection) => connection.on('message', (text) => connection.sendText(`echo:${text}`)),
  });
  const replies = collect(socket, 'message', 6);
  for (let index = 0; index < 6; index += 1) assert.equal(socket.sendText(`hello ${index}`), true);
  assert.deepEqual(await replies, [0, 1, 2, 3, 4, 5].map((index) => `echo:hello ${index}`));
  assert.equal(conn.url, '/link?ticket=secret-ticket');
  assert.equal(conn.headers.upgrade, 'websocket');
  assert.match(conn.headers.connection ?? '', /upgrade/i);
  assert.equal(conn.headers['sec-websocket-version'], '13');
  assert.equal(conn.headers['user-agent'], 'commission-ai-slack');
  assert.equal(Buffer.from(conn.headers['sec-websocket-key'] ?? '', 'base64').length, 16);
  assert.equal(conn.frames.length, 6);
  assert.ok(conn.frames.every((frame) => frame.masked && frame.mask?.length === 4));
  assert.ok(new Set(conn.frames.map((frame) => frame.mask?.toString('hex'))).size > 1);
  assert.equal(server.connections.length, 1);
});

test('text frames of every length class round trip in both directions', async (t) => {
  const { socket } = await start(
    t,
    { onConnection: (connection) => connection.on('message', (text) => connection.sendText(text)) },
    { maxMessageBytes: 200000 },
  );
  for (const size of [0, 1, 125, 126, 65535, 65536, 150000]) {
    const text = 'a'.repeat(size);
    const reply = collect(socket, 'message', 1);
    assert.equal(socket.sendText(text), true);
    assert.deepEqual(await reply, [text], String(size));
  }
  const unicode = 'café \u{1f600} 世界';
  const reply = collect(socket, 'message', 1);
  socket.sendText(unicode);
  assert.deepEqual(await reply, [unicode]);
});

test('fragmented messages are reassembled byte-wise around interleaved control frames', async (t) => {
  const ready = deferred();
  const { socket, conn } = await start(t, { onConnection: (connection) => ready.resolve(connection) });
  const seen = track(socket);
  const messages = collect(socket, 'message', 2);
  conn.sendFrame({ opcode: 1, payload: Buffer.concat([Buffer.from('caf'), Buffer.from([0xc3])]), fin: false });
  conn.sendPing(Buffer.from('mid'));
  conn.sendFrame({ opcode: 0, payload: Buffer.concat([Buffer.from([0xa9]), Buffer.from('!')]), fin: false });
  conn.sendFrame({ opcode: 0, payload: Buffer.from(' ok'), fin: true });
  conn.sendText('next');
  assert.deepEqual(await messages, ['café! ok', 'next']);
  assert.deepEqual(seen.pings.map((payload) => payload.toString()), ['mid']);
  assert.equal(seen.errors.length, 0);
});

test('binary frames are ignored, including fragmented ones', async (t) => {
  const { socket, conn } = await start(t);
  const messages = collect(socket, 'message', 1);
  conn.sendBinary(Buffer.from([1, 2, 3]));
  conn.sendFrame({ opcode: 2, payload: Buffer.from([4]), fin: false });
  conn.sendFrame({ opcode: 0, payload: Buffer.from([5]), fin: true });
  conn.sendText('text');
  assert.deepEqual(await messages, ['text']);
});

test('several frames in one chunk and frames split across chunks are delivered in order', async (t) => {
  const { socket, conn } = await start(t);
  const messages = collect(socket, 'message', 5);
  conn.sendRaw(
    Buffer.concat([
      encodeFrame({ opcode: 1, payload: 'a' }),
      encodeFrame({ opcode: 1, payload: 'b' }),
      encodeFrame({ opcode: 1, payload: 'c' }),
    ]),
  );
  const split = encodeFrame({ opcode: 1, payload: 'x'.repeat(300) });
  for (const part of [split.subarray(0, 1), split.subarray(1, 3), split.subarray(3, 100), split.subarray(100)]) {
    await new Promise((resolve) => conn.socket.write(part, resolve));
  }
  conn.sendText('tail');
  assert.deepEqual(await messages, ['a', 'b', 'c', 'x'.repeat(300), 'tail']);
});

test('a frame sent right behind the handshake reply is not lost', async (t) => {
  const { socket } = await start(
    t,
    { response: ({ standard }) => Buffer.concat([Buffer.from(standard), encodeFrame({ opcode: 1, payload: 'hello' })]) },
    {},
  );
  const seen = track(socket);
  await new Promise((resolve) => socket.once('message', resolve));
  assert.deepEqual(seen.messages, ['hello']);
});

test('ping and pong are exposed and never answered automatically', async (t) => {
  const { socket, conn } = await start(t);
  const seen = track(socket);
  const serverPings = collect(conn, 'ping', 1);
  const serverPongs = collect(conn, 'pong', 2);
  const clientPongs = collect(socket, 'pong', 1);
  conn.sendPing(Buffer.from('abc'));
  await new Promise((resolve) => socket.once('ping', resolve));
  assert.deepEqual(seen.pings.map((payload) => payload.toString()), ['abc']);
  assert.equal(socket.sendPong(seen.pings[0]), true);
  assert.equal(socket.sendPing(Buffer.from('xyz')), true);
  assert.deepEqual((await serverPings).map((payload) => payload.toString()), ['xyz']);
  conn.sendPong(Buffer.from('xyz'));
  assert.deepEqual((await clientPongs).map((payload) => payload.toString()), ['xyz']);
  assert.equal(socket.sendPong(), true);
  assert.deepEqual((await serverPongs).map((payload) => payload.toString()), ['abc', '']);
  assert.equal(socket.sendPing(Buffer.alloc(126)), false);
  assert.equal(socket.sendPong(Buffer.alloc(200)), false);
  assert.equal(socket.sendPing(Buffer.alloc(125)), true);
  assert.equal(conn.frames.filter((frame) => frame.opcode === 10).length, 2);
});

test('a server close frame is answered and close is emitted exactly once', async (t) => {
  const { socket, conn } = await start(t);
  const seen = track(socket);
  const serverClosed = new Promise((resolve) => conn.once('close', resolve));
  assert.equal(conn.sendClose(1001, 'bye'), true);
  assert.deepEqual(await seen.closed, { code: 1001, reason: 'bye', clean: true });
  await serverClosed;
  assert.equal(conn.closeCode, 1001);
  assert.equal(socket.sendText('late'), false);
  assert.equal(socket.sendPing(), false);
  assert.equal(socket.sendPong(), false);
  assert.equal(socket.close(), false);
  socket.terminate();
  await yieldToLoop();
  assert.equal(seen.closes.length, 1);
  assert.equal(seen.errors.length, 0);
});

test('close sends a close frame, waits for the peer and refuses further sends', async (t) => {
  const { socket, conn } = await start(t);
  const seen = track(socket);
  assert.equal(socket.close(), true);
  assert.equal(socket.close(), false);
  assert.equal(socket.sendText('late'), false);
  assert.deepEqual(await seen.closed, { code: 1000, reason: '', clean: true });
  assert.equal(conn.closeCode, 1000);
  assert.equal(seen.closes.length, 1);
  const other = await start(t);
  const otherSeen = track(other.socket);
  other.socket.close(4001);
  assert.deepEqual(await otherSeen.closed, { code: 4001, reason: '', clean: true });
  assert.equal(other.conn.closeCode, 4001);
  const invalid = await start(t);
  const invalidSeen = track(invalid.socket);
  invalid.socket.close(1005);
  await invalidSeen.closed;
  assert.equal(invalid.conn.closeCode, 1000);
});

test('close destroys the socket when the peer never answers the close frame', async (t) => {
  const { socket, conn } = await start(
    t,
    { onConnection: (connection) => Object.assign(connection, { answerClose: false }) },
    { closeTimeoutMs: 20 },
  );
  const seen = track(socket);
  assert.equal(socket.close(1000), true);
  assert.deepEqual(await seen.closed, { code: 1006, reason: '', clean: false });
  assert.equal(conn.closeCode, 1000);
  assert.equal(seen.closes.length, 1);
});

test('terminate destroys immediately and reports an abnormal close once', async (t) => {
  const { socket } = await start(t);
  const seen = track(socket);
  socket.terminate();
  assert.equal(socket.sendText('x'), false);
  assert.equal(socket.sendPing(), false);
  assert.equal(socket.close(), false);
  assert.deepEqual(await seen.closed, { code: 1006, reason: '', clean: false });
  socket.terminate();
  await yieldToLoop();
  assert.equal(seen.closes.length, 1);
});

test('a dropped connection without a close frame closes abnormally', async (t) => {
  const { socket, conn } = await start(t);
  const seen = track(socket);
  conn.terminate();
  const info = await seen.closed;
  assert.equal(info.code, 1006);
  assert.equal(info.clean, false);
  assert.equal(seen.closes.length, 1);
  assert.equal(socket.sendText('x'), false);
});

test('oversized messages close with 1009 after an error and never leak the URL', async (t) => {
  const sizes = [
    (conn) => conn.sendText('x'.repeat(2000)),
    (conn) => conn.sendRaw(Buffer.from([0x81, 126, 0x13, 0x88])),
    (conn) => conn.sendRaw(Buffer.from([0x82, 127, 0, 0, 1, 0, 0, 0, 0, 0])),
    (conn) => {
      conn.sendFrame({ opcode: 1, payload: 'y'.repeat(600), fin: false });
      conn.sendFrame({ opcode: 0, payload: 'y'.repeat(600), fin: false });
      conn.sendFrame({ opcode: 0, payload: 'y'.repeat(600), fin: true });
    },
  ];
  for (const [index, trigger] of sizes.entries()) {
    const { socket, conn } = await start(t, {}, { maxMessageBytes: 1000 });
    const seen = track(socket);
    trigger(conn);
    const info = await seen.closed;
    assert.deepEqual(seen.order, ['error', 'close'], String(index));
    assert.equal(seen.errors[0]?.closeCode, 1009);
    assert.equal(seen.errors[0]?.kind, 'unsure');
    assert.equal(seen.errors[0]?.text, 'Slack sent a message larger than the limit');
    assertSafeError(seen.errors[0]);
    assert.equal(info.code, 1009);
    assert.equal(info.clean, false);
    assert.equal(seen.messages.length, 0);
    assert.equal(conn.closeCode, 1009);
  }
});

test('protocol violations close with 1002 or 1007, error first, and deliver nothing', async (t) => {
  const scenarios = [
    ['masked server frame', 1002, (conn) => conn.sendRaw(encodeFrame({ opcode: 1, payload: 'hi', mask: crypto.randomBytes(4) }))],
    ['reserved bits', 1002, (conn) => conn.sendRaw(Buffer.from([0xc1, 0x00]))],
    ['unknown opcode', 1002, (conn) => conn.sendRaw(Buffer.from([0x83, 0x00]))],
    ['fragmented control frame', 1002, (conn) => conn.sendRaw(Buffer.from([0x09, 0x00]))],
    ['oversized control frame', 1002, (conn) => conn.sendRaw(encodeFrame({ opcode: 9, payload: Buffer.alloc(126) }))],
    ['continuation without a start', 1002, (conn) => conn.sendFrame({ opcode: 0, payload: 'x' })],
    [
      'new message inside a fragmented one',
      1002,
      (conn) => {
        conn.sendFrame({ opcode: 1, payload: 'a', fin: false });
        conn.sendText('b');
      },
    ],
    ['one byte close payload', 1002, (conn) => conn.sendFrame({ opcode: 8, payload: Buffer.from([3]) })],
    ['invalid close code', 1002, (conn) => conn.sendFrame({ opcode: 8, payload: Buffer.from([0x03, 0xed]) })],
    ['invalid utf-8 text', 1007, (conn) => conn.sendFrame({ opcode: 1, payload: Buffer.from([0xff, 0xfe]) })],
    [
      'invalid utf-8 across fragments',
      1007,
      (conn) => {
        conn.sendFrame({ opcode: 1, payload: Buffer.from([0xc3]), fin: false });
        conn.sendFrame({ opcode: 0, payload: Buffer.from([0x28]), fin: true });
      },
    ],
  ];
  for (const [name, code, trigger] of scenarios) {
    const { socket, conn } = await start(t);
    const seen = track(socket);
    trigger(conn);
    const info = await seen.closed;
    assert.deepEqual(seen.order, ['error', 'close'], name);
    assert.equal(seen.errors.length, 1, name);
    assert.equal(seen.errors[0]?.closeCode, code, name);
    assert.match(seen.errors[0]?.text ?? '', /^Slack sent (data that is not valid WebSocket|text that is not valid UTF-8)/, name);
    assertSafeError(seen.errors[0]);
    assert.equal(info.code, code, name);
    assert.equal(info.clean, false, name);
    assert.equal(seen.closes.length, 1, name);
    assert.deepEqual(seen.messages, [], name);
    assert.equal(conn.closeCode, code, name);
    assert.equal(socket.sendText('after'), false, name);
  }
});

test('a protocol violation without an error listener still ends in close and does not throw', async (t) => {
  const { socket, conn } = await start(t);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  conn.sendRaw(Buffer.from([0xc1, 0x00]));
  assert.equal((await closed).code, 1002);
});

test('a failed close handshake falls back to the close timeout after a protocol error', async (t) => {
  const { socket, conn } = await start(
    t,
    { onConnection: (connection) => Object.assign(connection, { answerClose: false }) },
    { closeTimeoutMs: 20 },
  );
  const seen = track(socket);
  conn.sendRaw(Buffer.from([0xc1, 0x00]));
  const info = await seen.closed;
  assert.equal(info.code, 1002);
  assert.equal(info.clean, false);
});

test('a refused upgrade rejects as unsent without the URL', async (t) => {
  const server = await startWsServer({ response: () => 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n' });
  t.after(() => server.close());
  const error = await failure(connect(server.url, { env: {}, what: 'Slack' }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'Slack refused the connection (HTTP 403)');
  assertSafeError(error);
});

test('an invalid handshake reply rejects as unsure', async (t) => {
  const replies = [
    ({ accept }) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}x\r\n\r\n`,
    () => 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    ({ accept }) => `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    ({ accept }) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    () => 'garbage\r\n\r\n',
    () => `HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${'a'.repeat(20000)}\r\n\r\n`,
  ];
  for (const [index, response] of replies.entries()) {
    const server = await startWsServer({ response });
    t.after(() => server.close());
    const error = await failure(connect(server.url, { env: {}, what: 'Slack' }));
    assert.equal(error.kind, 'unsure', String(index));
    assert.equal(error.text, 'Slack sent an invalid WebSocket handshake', String(index));
    assertSafeError(error);
  }
});

test('a connection closed during the handshake rejects as unsure', async (t) => {
  const server = await startWsServer({
    response: ({ request }) => {
      request.socket.destroy();
      return false;
    },
  });
  t.after(() => server.close());
  const error = await failure(connect(server.url, { env: {}, what: 'Slack' }));
  assert.equal(error.kind, 'unsure');
  assert.equal(error.text, 'Slack closed the connection during the handshake');
  assertSafeError(error);
});

test('a silent handshake times out with the connect timeout', async (t) => {
  const server = await startWsServer({ response: () => false });
  t.after(() => server.close());
  const error = await failure(connect(server.url, { env: {}, what: 'Slack', connectTimeoutMs: 100 }));
  assert.equal(error.kind, 'unsure');
  assert.equal(error.text, "Slack didn't answer in time");
  assertSafeError(error);
});

test('connect reports unreachable servers and invalid addresses without the URL', async () => {
  const port = await closedPort();
  const refused = await failure(connect(`ws://127.0.0.1:${port}/link?ticket=secret-ticket`, { env: {}, what: 'Slack' }));
  assert.equal(refused.kind, 'unsent');
  assert.equal(refused.text, "Can't reach Slack (ECONNREFUSED)");
  assertSafeError(refused);
  for (const value of ['http://example.com/', 'nope', undefined, 'https://example.com/link?ticket=secret-ticket']) {
    const error = await failure(connect(value, { env: {} }));
    assert.equal(error.kind, 'unsent');
    assert.equal(error.text, 'The address is not a WebSocket address');
    assertSafeError(error);
  }
});

test('connect cancels a hanging handshake as unsure and removes its listener', async (t) => {
  const arrived = deferred();
  const dropped = deferred();
  const server = await startWsServer({
    response: () => false,
    onConnection: (connection) => {
      connection.once('close', () => dropped.resolve());
      arrived.resolve();
    },
  });
  t.after(() => server.close());
  const controller = new AbortController();
  const pending = failure(connect(server.url, { env: {}, what: 'Slack', signal: controller.signal }));
  await arrived.promise;
  await yieldToLoop();
  controller.abort();
  const error = await pending;
  assert.equal(error.kind, 'unsure');
  assert.equal(error.text, 'The connection was cancelled');
  assertSafeError(error);
  await dropped.promise;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('connect removes its abort listener once connected and ignores later aborts', async (t) => {
  const controller = new AbortController();
  const { socket } = await start(t, {}, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const seen = track(socket);
  controller.abort();
  await yieldToLoop();
  assert.equal(seen.closes.length, 0);
  assert.equal(socket.sendText('still open'), true);
});

test('connect rejects an already aborted signal without connecting', async (t) => {
  const server = await startWsServer();
  t.after(() => server.close());
  const pending = connect(server.url, { env: {}, signal: AbortSignal.abort() });
  assert.ok(pending instanceof Promise);
  const error = await failure(pending);
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The connection was cancelled');
  assert.equal(server.connections.length, 0);
});

test('connect cancels while the proxy tunnel is being set up as unsent', async (t) => {
  const proxy = await startProxy({ mode: 'hang' });
  t.after(() => proxy.close());
  const controller = new AbortController();
  const pending = failure(
    connect('wss://slack-test.example/link?ticket=secret-ticket', {
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      signal: controller.signal,
    }),
  );
  while (proxy.requests.length === 0) await yieldToLoop();
  controller.abort();
  const error = await pending;
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The connection was cancelled');
  assertSafeError(error);
});

test('connect works through a CONNECT proxy for ws', async (t) => {
  const server = await startWsServer({ onConnection: (conn) => conn.on('message', (text) => conn.sendText(`echo:${text}`)) });
  t.after(() => server.close());
  const proxy = await startProxy({ route: { 'slack-test.example:80': `127.0.0.1:${server.port}` } });
  t.after(() => proxy.close());
  const socket = await connect('ws://slack-test.example/link?ticket=secret-ticket', {
    env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` },
  });
  t.after(() => socket.terminate());
  const reply = collect(socket, 'message', 1);
  socket.sendText('hi');
  assert.deepEqual(await reply, ['echo:hi']);
  assert.deepEqual(proxy.requests, [CONNECT_HEAD('slack-test.example:80')]);
  assert.equal(server.connections[0]?.headers.host, 'slack-test.example');
});

test('connect works over TLS through a CONNECT proxy and verifies the certificate', async (t) => {
  const server = await startWsServer({
    tls: { key: certificate.key, cert: certificate.cert },
    onConnection: (conn) => conn.on('message', (text) => conn.sendText(`echo:${text}`)),
  });
  t.after(() => server.close());
  assert.ok(server.url.startsWith('wss://'));
  const proxy = await startProxy({ route: { 'slack-test.example:443': `127.0.0.1:${server.port}` } });
  t.after(() => proxy.close());
  const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
  const socket = await connect('wss://slack-test.example/link?ticket=secret-ticket', {
    env,
    tlsOptions: { ca: certificate.cert },
  });
  t.after(() => socket.terminate());
  const reply = collect(socket, 'message', 1);
  socket.sendText('secure');
  assert.deepEqual(await reply, ['echo:secure']);
  assert.deepEqual(proxy.requests, [CONNECT_HEAD('slack-test.example:443')]);
  const untrusted = await failure(connect('wss://slack-test.example/link?ticket=secret-ticket', { env, what: 'Slack' }));
  assert.equal(untrusted.kind, 'unsent');
  assert.match(untrusted.text, /^Can't reach Slack \([A-Z_]+\)$/);
  assertSafeError(untrusted);
});

test('connect through a refusing proxy reports the refusal without the ticket', async (t) => {
  const proxy = await startProxy({ mode: 'refuse' });
  t.after(() => proxy.close());
  const error = await failure(
    connect('wss://slack-test.example/link?ticket=secret-ticket', {
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      what: 'Slack',
    }),
  );
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The proxy refused the connection to Slack (HTTP/1.1 407 Proxy Authentication Required)');
  assertSafeError(error);
});

test('a lost connection reports a safe error before close', async (t) => {
  const { socket, conn } = await start(t);
  const seen = track(socket);
  conn.socket.resetAndDestroy();
  await seen.closed;
  assert.ok(seen.errors.length <= 1);
  for (const error of seen.errors) {
    assert.equal(error.text, 'The connection to Slack was lost');
    assertSafeError(error);
  }
  assert.equal(seen.closes.length, 1);
  assert.equal(seen.closes[0]?.code, 1006);
  assert.ok(Socket.prototype.sendText);
});
