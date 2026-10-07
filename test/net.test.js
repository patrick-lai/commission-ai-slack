import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once, getEventListeners } from 'node:events';
import { NetError, openStream, proxyFor, request } from '../src/net.js';
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function shutdown(server, sockets) {
  return new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function startHttp(t, handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  t.after(() => shutdown(server, []));
  return { port, base: `http://127.0.0.1:${port}` };
}

async function startHttps(t, handler) {
  const server = https.createServer({ key: certificate.key, cert: certificate.cert }, handler);
  const names = [];
  server.on('secureConnection', (socket) => names.push(socket.servername));
  const port = await listen(server);
  t.after(() => shutdown(server, []));
  return { port, names };
}

async function startTcp(t, onSocket, secure = false) {
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', ignore);
  };
  const server = secure
    ? tls.createServer({ key: certificate.key, cert: certificate.cert }, onSocket)
    : net.createServer(onSocket);
  server.on('connection', track);
  const port = await listen(server);
  t.after(() => shutdown(server, sockets));
  return { port };
}

async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('expected a rejection');
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function assertSafe(error, secrets) {
  assert.ok(error instanceof NetError);
  const shown = `${error.text}|${error.message}|${JSON.stringify(error)}`;
  for (const secret of secrets) assert.ok(!shown.includes(secret), `leaked ${secret}`);
}

const PROXIED = { host: 'proxy.corp', port: 3128 };

test('proxyFor takes the first non-blank variable in documented order', () => {
  const secure = 'https://slack.com/api';
  assert.deepEqual(
    proxyFor(secure, { HTTPS_PROXY: 'http://a:1', https_proxy: 'http://b:2', ALL_PROXY: 'http://c:3', all_proxy: 'http://d:4' }),
    { host: 'a', port: 1 },
  );
  assert.deepEqual(proxyFor(secure, { HTTPS_PROXY: '   ', https_proxy: 'http://b:2', ALL_PROXY: 'http://c:3' }), { host: 'b', port: 2 });
  assert.deepEqual(proxyFor(secure, { https_proxy: '', ALL_PROXY: ' http://c:3 ', all_proxy: 'http://d:4' }), { host: 'c', port: 3 });
  assert.deepEqual(proxyFor(secure, { all_proxy: 'http://d:4' }), { host: 'd', port: 4 });
  assert.equal(proxyFor(secure, { HTTP_PROXY: 'http://a:1', http_proxy: 'http://a:1' }), null);
  assert.equal(proxyFor(secure, {}), null);
  assert.equal(proxyFor(secure, null), null);
});

test('proxyFor uses the http variables for http and ws and the https variables for https and wss', () => {
  const env = { HTTP_PROXY: 'http://plain:1', HTTPS_PROXY: 'http://secure:2' };
  assert.deepEqual(proxyFor('http://slack.com/', env), { host: 'plain', port: 1 });
  assert.deepEqual(proxyFor('ws://slack.com/', env), { host: 'plain', port: 1 });
  assert.deepEqual(proxyFor('https://slack.com/', env), { host: 'secure', port: 2 });
  assert.deepEqual(proxyFor('wss://slack.com/', env), { host: 'secure', port: 2 });
  assert.deepEqual(proxyFor('http://slack.com/', { http_proxy: 'http://lower:3', ALL_PROXY: 'http://all:4' }), { host: 'lower', port: 3 });
  assert.equal(proxyFor('ftp://slack.com/', env), null);
  assert.equal(proxyFor('not a url', env), null);
  assert.equal(proxyFor(undefined, env), null);
});

test('proxyFor never proxies loopback, private or link-local hosts', () => {
  const env = { ALL_PROXY: 'http://proxy.corp:3128' };
  const direct = [
    'http://localhost/',
    'http://LOCALHOST:8080/',
    'http://127.0.0.1/',
    'http://127.200.3.4/',
    'http://[::1]/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.10.20/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://printer.local/',
    'https://nas.office.local/',
    'wss://10.1.2.3/',
  ];
  for (const url of direct) assert.equal(proxyFor(url, env), null, url);
  const proxied = [
    'http://172.15.0.1/',
    'http://172.32.0.1/',
    'http://192.169.0.1/',
    'http://169.253.0.1/',
    'http://11.0.0.1/',
    'http://[fec0::1]/',
    'http://[2001:db8::1]/',
    'http://localhost.example.com/',
    'http://example.localdomain/',
  ];
  for (const url of proxied) assert.deepEqual(proxyFor(url, env), PROXIED, url);
});

test('proxyFor honours NO_PROXY and no_proxy entries', () => {
  const env = (value, key = 'NO_PROXY') => ({ HTTPS_PROXY: 'http://proxy.corp:3128', [key]: value });
  const exempt = [
    ['example.com', 'https://example.com/'],
    ['example.com', 'https://api.example.com/'],
    ['.example.com', 'https://api.example.com/'],
    ['*.example.com', 'https://api.example.com/'],
    ['*.example.com', 'https://example.com/'],
    ['  EXAMPLE.COM  ', 'https://Api.Example.Com/'],
    ['other.org, example.com ,more.net', 'https://example.com/'],
    ['*', 'https://anything.test/'],
    [',, ,example.com', 'https://example.com/'],
  ];
  for (const [value, url] of exempt) {
    assert.equal(proxyFor(url, env(value)), null, `${value} ${url}`);
    assert.equal(proxyFor(url, env(value, 'no_proxy')), null, `${value} ${url} lowercase`);
  }
  const proxied = [
    ['example.com', 'https://notexample.com/'],
    ['example.com', 'https://example.com.evil.test/'],
    ['api.example.com', 'https://example.com/'],
    ['example.com/path', 'https://example.com/'],
    ['10.0.0.0/8', 'https://example.org/'],
    ['', 'https://example.com/'],
    [' , ', 'https://example.com/'],
    ['.', 'https://example.com/'],
  ];
  for (const [value, url] of proxied) assert.deepEqual(proxyFor(url, env(value)), PROXIED, `${value} ${url}`);
  const both = { HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: 'a.test', no_proxy: 'b.test' };
  assert.equal(proxyFor('https://a.test/', both), null);
  assert.equal(proxyFor('https://b.test/', both), null);
  assert.deepEqual(proxyFor('https://c.test/', both), PROXIED);
});

test('proxyFor parses proxy values with default ports and ignores credentials', () => {
  const via = (value, url = 'https://slack.com/') => proxyFor(url, { ALL_PROXY: value });
  assert.deepEqual(via('proxy.corp:3128'), { host: 'proxy.corp', port: 3128 });
  assert.deepEqual(via('proxy.corp'), { host: 'proxy.corp', port: 80 });
  assert.deepEqual(via('http://proxy.corp'), { host: 'proxy.corp', port: 80 });
  assert.deepEqual(via('http://proxy.corp:80'), { host: 'proxy.corp', port: 80 });
  assert.deepEqual(via('https://proxy.corp'), { host: 'proxy.corp', port: 443 });
  assert.deepEqual(via('https://proxy.corp:8443'), { host: 'proxy.corp', port: 8443 });
  assert.deepEqual(via('http://user:p%40ss@proxy.corp:3128'), { host: 'proxy.corp', port: 3128 });
  assert.deepEqual(via('http://[2001:db8::2]:3128'), { host: '2001:db8::2', port: 3128 });
  assert.deepEqual(via('HTTP://Proxy.Corp:81'), { host: 'proxy.corp', port: 81 });
  assert.equal(via('socks5://proxy.corp:1080'), null);
  assert.equal(via('http://'), null);
  assert.equal(via('http://proxy.corp:99999'), null);
});

test('openStream sends the exact CONNECT request and relays bytes through the tunnel', async (t) => {
  const echo = await startTcp(t, (socket) => socket.pipe(socket));
  const proxy = await startProxy({ route: { 'slack-test.example:80': `127.0.0.1:${echo.port}` } });
  t.after(() => proxy.close());
  const stream = await openStream('ws://slack-test.example/socket?ticket=abc', {
    env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` },
  });
  t.after(() => stream.destroy());
  stream.write('ping');
  const [chunk] = await once(stream, 'data');
  assert.equal(chunk.toString(), 'ping');
  assert.deepEqual(proxy.requests, [CONNECT_HEAD('slack-test.example:80')]);
});

test('openStream keeps bytes the proxy sends right after the 200 reply', async (t) => {
  const proxy = await startTcp(t, (socket) => {
    socket.once('data', () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\nhello'));
  });
  const stream = await openStream('ws://slack-test.example/', { env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` } });
  t.after(() => stream.destroy());
  const [chunk] = await once(stream, 'data');
  assert.equal(chunk.toString(), 'hello');
});

test('openStream refuses a TLS tunnel that sends data before the handshake', async (t) => {
  const proxy = await startTcp(t, (socket) => {
    socket.once('data', () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\nx'));
  });
  const error = await failure(openStream('wss://slack-test.example/', { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The proxy refused the connection to the server (unexpected data)');
});

test('openStream writes IPv6 hosts in brackets in the CONNECT request', async (t) => {
  const proxy = await startProxy({ mode: 'refuse' });
  t.after(() => proxy.close());
  const error = await failure(
    openStream('https://[2001:db8::1]:8443/', { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }, what: 'Slack' }),
  );
  assert.equal(error.kind, 'unsent');
  assert.deepEqual(proxy.requests, [CONNECT_HEAD('[2001:db8::1]:8443')]);
});

test('openStream reports a refusing proxy with its status line and no URL', async (t) => {
  const proxy = await startProxy({ mode: 'refuse' });
  t.after(() => proxy.close());
  const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
  const error = await failure(openStream('https://slack-test.example/api?token=xoxb-secret', { env, what: 'Slack' }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.written, false);
  assert.equal(error.text, 'The proxy refused the connection to Slack (HTTP/1.1 407 Proxy Authentication Required)');
  assertSafe(error, ['xoxb-secret', '/api', 'slack-test.example']);
  assert.deepEqual(proxy.requests, [CONNECT_HEAD('slack-test.example:443')]);
});

test('openStream reports a proxy that closes the connection', async (t) => {
  const proxy = await startProxy({ mode: 'close' });
  t.after(() => proxy.close());
  const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
  const error = await failure(openStream('https://slack-test.example/api?token=xoxb-secret', { env, what: 'Slack' }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The proxy closed the connection to Slack');
  assertSafe(error, ['xoxb-secret', '/api', 'slack-test.example']);
});

test('openStream reports an unreachable proxy', async () => {
  const port = await closedPort();
  const env = { HTTPS_PROXY: `http://127.0.0.1:${port}` };
  const error = await failure(openStream('https://slack-test.example/api?token=xoxb-secret', { env, what: 'Slack' }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, `Can't reach the proxy 127.0.0.1:${port}`);
  assertSafe(error, ['xoxb-secret', '/api', 'slack-test.example']);
});

test('openStream bounds proxy dial, CONNECT and handshake with one connect timeout', async (t) => {
  const proxy = await startProxy({ mode: 'hang' });
  t.after(() => proxy.close());
  const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
  const error = await failure(openStream('wss://slack-test.example/link?ticket=secret', { env, what: 'Slack', connectTimeoutMs: 50 }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, "Slack didn't answer in time");
  assertSafe(error, ['secret', '/link', 'slack-test.example']);
});

test('openStream times out a silent TLS server', async (t) => {
  const silent = await startTcp(t, ignore);
  const error = await failure(openStream(`https://127.0.0.1:${silent.port}/`, { env: {}, connectTimeoutMs: 50 }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, "the server didn't answer in time");
});

test('openStream reports a refused direct connection with the error code only', async () => {
  const port = await closedPort();
  const error = await failure(openStream(`http://127.0.0.1:${port}/path?token=secret-token`, { env: {} }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, "Can't reach the server (ECONNREFUSED)");
  assertSafe(error, ['secret-token', '/path', String(port)]);
  const named = await failure(openStream(`http://127.0.0.1:${port}/`, { env: {}, what: 'Slack' }));
  assert.equal(named.text, "Can't reach Slack (ECONNREFUSED)");
});

test('openStream rejects invalid or unsupported addresses with typed errors', async () => {
  for (const value of ['nope', 'ftp://example.com/', undefined, 42, 'http://']) {
    const error = await failure(openStream(value, { env: {} }));
    assert.equal(error.kind, 'unsent');
    assert.equal(error.text, 'The address is not valid');
  }
});

test('openStream connects over TLS and verifies the certificate', async (t) => {
  const server = await startTcp(t, (socket) => socket.end('hello'), true);
  const stream = await openStream(`https://127.0.0.1:${server.port}/`, { env: {}, tlsOptions: { ca: certificate.cert } });
  t.after(() => stream.destroy());
  assert.equal(stream.authorized, true);
  const [chunk] = await once(stream, 'data');
  assert.equal(chunk.toString(), 'hello');
  const error = await failure(openStream(`https://127.0.0.1:${server.port}/`, { env: {} }));
  assert.equal(error.kind, 'unsent');
  assert.match(error.text, /^Can't reach the server \([A-Z_]+\)$/);
});

test('openStream tunnels TLS through CONNECT with SNI and certificate name checks', async (t) => {
  const names = [];
  const server = await startTcp(
    t,
    (socket) => {
      names.push(socket.servername);
      socket.end('hello');
    },
    true,
  );
  const proxy = await startProxy({
    route: { 'slack-test.example:443': `127.0.0.1:${server.port}`, 'other.example:443': `127.0.0.1:${server.port}` },
  });
  t.after(() => proxy.close());
  const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
  const stream = await openStream('https://slack-test.example/', { env, tlsOptions: { ca: certificate.cert } });
  t.after(() => stream.destroy());
  const [chunk] = await once(stream, 'data');
  assert.equal(chunk.toString(), 'hello');
  assert.deepEqual(names, ['slack-test.example']);
  assert.deepEqual(proxy.requests, [CONNECT_HEAD('slack-test.example:443')]);
  const mismatch = await failure(openStream('https://other.example/', { env, tlsOptions: { ca: certificate.cert } }));
  assert.equal(mismatch.kind, 'unsent');
  assert.equal(mismatch.text, "Can't reach the server (ERR_TLS_CERT_ALTNAME_INVALID)");
});

test('openStream cancels on an already aborted signal and while the proxy hangs', async (t) => {
  const aborted = await failure(openStream('http://127.0.0.1:9/', { env: {}, signal: AbortSignal.abort() }));
  assert.equal(aborted.kind, 'unsent');
  assert.equal(aborted.text, 'The connection was cancelled');
  const proxy = await startProxy({ mode: 'hang' });
  t.after(() => proxy.close());
  const controller = new AbortController();
  const pending = failure(
    openStream('wss://slack-test.example/', { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }, signal: controller.signal }),
  );
  while (proxy.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const error = await pending;
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The connection was cancelled');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('request returns status, lowercase headers, joined repeats, body and final url', async (t) => {
  const seen = deferred();
  const server = await startHttp(t, (req, res) => {
    seen.resolve(req);
    res.statusCode = 201;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('X-Multi', ['a', 'b']);
    res.end('hello');
  });
  const response = await request({ url: `${server.base}/path?x=1`, env: {} });
  assert.equal(response.status, 201);
  assert.equal(response.headers['content-type'], 'text/plain');
  assert.equal(response.headers['x-multi'], 'a, b');
  assert.deepEqual(Object.keys(response.headers).filter((name) => name !== name.toLowerCase()), []);
  assert.ok(Buffer.isBuffer(response.body));
  assert.equal(response.body.toString(), 'hello');
  assert.ok(response.url instanceof URL);
  assert.equal(response.url.href, `${server.base}/path?x=1`);
  const req = await seen.promise;
  assert.equal(req.method, 'GET');
  assert.equal(req.url, '/path?x=1');
  assert.equal(req.headers['accept-encoding'], 'identity');
  assert.equal(req.headers['user-agent'], 'commission-ai-slack');
  assert.equal(req.headers.connection, 'close');
  assert.equal(req.headers['content-length'], undefined);
  assert.equal(req.headers['transfer-encoding'], undefined);
});

test('request does not throw on error statuses and accepts a URL object', async (t) => {
  const server = await startHttp(t, (_req, res) => {
    res.statusCode = 503;
    res.end('busy');
  });
  const response = await request({ url: new URL(`${server.base}/x`), env: {} });
  assert.equal(response.status, 503);
  assert.equal(response.body.toString(), 'busy');
});

test('request sets content-length for bodies and never chunks', async (t) => {
  const seen = [];
  const server = await startHttp(t, async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method, headers: req.headers, body: body.toString() });
    res.end('ok');
  });
  await request({
    url: `${server.base}/a`,
    method: 'post',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '999', 'Transfer-Encoding': 'chunked', Authorization: 'Bearer secret' },
    body: '{"text":"héllo"}',
    env: {},
  });
  await request({ url: `${server.base}/b`, method: 'PUT', body: Buffer.from([1, 2, 3]), env: {} });
  await request({ url: `${server.base}/c`, method: 'POST', env: {} });
  await request({ url: `${server.base}/d`, method: 'PATCH', body: new Uint8Array([9, 9]), env: {} });
  assert.equal(seen[0]?.method, 'POST');
  assert.equal(seen[0]?.body, '{"text":"héllo"}');
  assert.equal(seen[0]?.headers['content-length'], String(Buffer.byteLength('{"text":"héllo"}')));
  assert.equal(seen[0]?.headers['transfer-encoding'], undefined);
  assert.equal(seen[0]?.headers['content-type'], 'application/json');
  assert.equal(seen[0]?.headers.authorization, 'Bearer secret');
  assert.equal(seen[1]?.headers['content-length'], '3');
  assert.equal(seen[2]?.headers['content-length'], '0');
  assert.equal(seen[2]?.headers['transfer-encoding'], undefined);
  assert.equal(seen[3]?.headers['content-length'], '2');
});

test('request classifies a refused connection as unsent without leaking the URL', async () => {
  const port = await closedPort();
  const error = await failure(request({ url: `http://127.0.0.1:${port}/path?token=secret-token`, headers: { authorization: 'Bearer secret-token' }, env: {} }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.written, false);
  assert.equal(error.text, "Can't reach the server (ECONNREFUSED)");
  assertSafe(error, ['secret-token', '/path', String(port)]);
});

test('request rejects invalid input with typed unsent errors', async () => {
  for (const options of [undefined, {}, { url: 'nope' }, { url: 'ftp://example.com/' }, { url: 'http://x.test/', method: 'bad method' }, { url: 'http://x.test/', body: 5 }]) {
    const error = await failure(request(options));
    assert.ok(error instanceof NetError);
    assert.equal(error.kind, 'unsent');
  }
  const headers = await failure(request({ url: 'http://127.0.0.1:9/', headers: { 'x-bad': 'a\r\nb: c' }, env: {} }));
  assert.equal(headers.kind, 'unsent');
  assert.equal(headers.text, 'The request could not be built');
});

test('request times out as unsent before the request is written', async (t) => {
  const connected = deferred();
  const silent = await startTcp(t, (socket) => {
    socket.once('data', () => connected.resolve());
  });
  const error = await failure(request({ url: `https://127.0.0.1:${silent.port}/path?token=secret-token`, timeoutMs: 100, env: {} }));
  assert.equal(error.kind, 'unsent');
  assert.equal(error.written, false);
  assert.equal(error.text, 'The request timed out');
  assertSafe(error, ['secret-token', '/path']);
  await connected.promise;
});

test('request times out as unsure after the request was written', async (t) => {
  const received = deferred();
  const server = await startHttp(t, (req) => {
    received.resolve(req.url);
  });
  const error = await failure(request({ url: `${server.base}/slow?token=secret-token`, timeoutMs: 250, env: {} }));
  assert.equal(await received.promise, '/slow?token=secret-token');
  assert.equal(error.kind, 'unsure');
  assert.equal(error.written, true);
  assert.equal(error.text, 'The request timed out');
  assertSafe(error, ['secret-token', '/slow']);
});

test('request classifies a reset after the write as unsure', async (t) => {
  const server = await startHttp(t, (req) => {
    req.socket.destroy();
  });
  const error = await failure(request({ url: `${server.base}/x`, method: 'POST', body: 'data', env: {} }));
  assert.equal(error.kind, 'unsure');
  assert.equal(error.written, true);
  assert.match(error.text, /^The connection to the server was lost/);
});

test('request classifies a malformed response as unsure', async (t) => {
  const server = await startTcp(t, (socket) => {
    socket.once('data', () => socket.end('this is not http\r\n\r\n'));
  });
  const error = await failure(request({ url: `http://127.0.0.1:${server.port}/`, env: {} }));
  assert.equal(error.kind, 'unsure');
  assert.equal(error.text, 'The server sent a response that could not be read');
});

test('request classifies a response cut short as unsure', async (t) => {
  const server = await startTcp(t, (socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort'));
  });
  const error = await failure(request({ url: `http://127.0.0.1:${server.port}/`, env: {} }));
  assert.equal(error.kind, 'unsure');
});

test('request rejects an oversized Content-Length before buffering and destroys the socket', async (t) => {
  const closed = deferred();
  const server = await startHttp(t, (req, res) => {
    req.socket.once('close', () => closed.resolve());
    res.writeHead(200, { 'Content-Length': 100000 });
    res.write('x'.repeat(100));
  });
  const error = await failure(request({ url: `${server.base}/big`, maxBytes: 10, env: {} }));
  assert.equal(error.kind, 'too_large');
  assert.equal(error.text, 'The response is larger than 10 bytes');
  await closed.promise;
});

test('request rejects an oversized streamed body and destroys the socket', async (t) => {
  const closed = deferred();
  const server = await startHttp(t, (req, res) => {
    req.socket.once('close', () => closed.resolve());
    res.writeHead(200);
    const chunk = Buffer.alloc(1024, 97);
    const pump = () => {
      while (!res.destroyed && res.write(chunk)) continue;
      if (!res.destroyed) res.once('drain', pump);
    };
    pump();
  });
  const error = await failure(request({ url: `${server.base}/stream`, maxBytes: 4096, env: {} }));
  assert.equal(error.kind, 'too_large');
  await closed.promise;
});

test('request accepts a body exactly at maxBytes and ignores the limit for HEAD', async (t) => {
  const server = await startHttp(t, (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': 5000 });
      res.end();
      return;
    }
    res.end('12345');
  });
  const exact = await request({ url: `${server.base}/`, maxBytes: 5, env: {} });
  assert.equal(exact.body.toString(), '12345');
  const head = await request({ url: `${server.base}/`, method: 'HEAD', maxBytes: 5, env: {} });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

function redirectServer(t, table, hits) {
  return startHttp(t, async (req, res) => {
    const body = await readBody(req);
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString() });
    const entry = table[req.url ?? ''];
    if (entry === undefined) {
      res.statusCode = 404;
      res.end('missing');
      return;
    }
    const [status, location, text] = entry;
    if (location !== null) res.setHeader('Location', location);
    res.statusCode = status;
    res.end(text ?? '');
  });
}

test('request does not follow redirects unless asked', async (t) => {
  const hits = [];
  const server = await redirectServer(t, { '/start': [302, '/next'], '/next': [200, null, 'done'] }, hits);
  const response = await request({ url: `${server.base}/start`, env: {} });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/next');
  assert.equal(response.url.pathname, '/start');
  assert.equal(hits.length, 1);
});

test('request follows redirects while allow says yes and resolves relative locations', async (t) => {
  const hits = [];
  const server = await redirectServer(
    t,
    { '/a/start': [302, '../b/next'], '/b/next': [301, '/c/final?x=1'], '/c/final?x=1': [200, null, 'done'] },
    hits,
  );
  const allowed = [];
  const response = await request({
    url: `${server.base}/a/start`,
    redirect: {
      max: 5,
      allow: (next) => {
        allowed.push(next);
        return true;
      },
    },
    env: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'done');
  assert.equal(response.url.href, `${server.base}/c/final?x=1`);
  assert.deepEqual(
    allowed.map((next) => next instanceof URL && next.pathname),
    ['/b/next', '/c/final'],
  );
  assert.deepEqual(hits.map((hit) => hit.url), ['/a/start', '/b/next', '/c/final?x=1']);
});

test('request stops and returns the redirect when allow refuses it', async (t) => {
  const hits = [];
  const server = await redirectServer(t, { '/start': [302, '/next'], '/next': [200, null, 'done'] }, hits);
  const response = await request({ url: `${server.base}/start`, redirect: { max: 5, allow: () => false }, env: {} });
  assert.equal(response.status, 302);
  assert.equal(response.url.pathname, '/start');
  assert.equal(hits.length, 1);
  const thrown = await request({
    url: `${server.base}/start`,
    redirect: {
      max: 5,
      allow: () => {
        throw new Error('boom');
      },
    },
    env: {},
  });
  assert.equal(thrown.status, 302);
});

test('request stops at the hop limit and returns the last redirect response', async (t) => {
  const hits = [];
  const table = { '/r0': [302, '/r1'], '/r1': [302, '/r2'], '/r2': [302, '/r3'], '/r3': [200, null, 'end'] };
  const server = await redirectServer(t, table, hits);
  const limited = await request({ url: `${server.base}/r0`, redirect: { max: 2, allow: () => true }, env: {} });
  assert.equal(limited.status, 302);
  assert.equal(limited.url.pathname, '/r2');
  assert.equal(limited.headers.location, '/r3');
  const none = await request({ url: `${server.base}/r0`, redirect: { max: 0, allow: () => true }, env: {} });
  assert.equal(none.status, 302);
  assert.equal(none.url.pathname, '/r0');
  const enough = await request({ url: `${server.base}/r0`, redirect: { max: 3, allow: () => true }, env: {} });
  assert.equal(enough.status, 200);
  assert.equal(enough.body.toString(), 'end');
});

test('request returns the redirect when Location is missing or unusable', async (t) => {
  const hits = [];
  const table = {
    '/none': [302, null],
    '/bad': [302, 'http://[bad'],
    '/file': [302, 'file:///etc/passwd'],
    '/blank': [302, ' '],
  };
  const server = await redirectServer(t, table, hits);
  for (const path of ['/none', '/bad', '/file', '/blank']) {
    const response = await request({ url: `${server.base}${path}`, redirect: { max: 5, allow: () => true }, env: {} });
    assert.equal(response.status, 302, path);
    assert.equal(response.url.pathname, path);
  }
});

test('request switches to GET and drops the body on 301, 302 and 303', async (t) => {
  for (const status of [301, 302, 303]) {
    const hits = [];
    const server = await redirectServer(t, { '/post': [status, '/landing'], '/landing': [200, null, 'ok'] }, hits);
    const response = await request({
      url: `${server.base}/post`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keep': 'yes' },
      body: '{"a":1}',
      redirect: { max: 3, allow: () => true },
      env: {},
    });
    assert.equal(response.status, 200, String(status));
    assert.equal(hits[0]?.method, 'POST');
    assert.equal(hits[1]?.method, 'GET', String(status));
    assert.equal(hits[1]?.body, '');
    assert.equal(hits[1]?.headers['content-length'], undefined);
    assert.equal(hits[1]?.headers['content-type'], undefined);
    assert.equal(hits[1]?.headers['x-keep'], 'yes');
  }
});

test('request resends method and body on 307 and 308', async (t) => {
  for (const status of [307, 308]) {
    const hits = [];
    const server = await redirectServer(t, { '/post': [status, '/landing'], '/landing': [200, null, 'ok'] }, hits);
    const response = await request({
      url: `${server.base}/post`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      redirect: { max: 3, allow: () => true },
      env: {},
    });
    assert.equal(response.status, 200);
    assert.equal(hits[1]?.method, 'POST', String(status));
    assert.equal(hits[1]?.body, '{"a":1}');
    assert.equal(hits[1]?.headers['content-length'], '7');
    assert.equal(hits[1]?.headers['content-type'], 'application/json');
  }
});

test('request drops credentials only when a redirect changes origin', async (t) => {
  const farHits = [];
  const far = await redirectServer(t, { '/far': [200, null, 'far'], '/back': [302, null] }, farHits);
  const nearHits = [];
  const near = await redirectServer(
    t,
    { '/same': [302, '/same2'], '/same2': [200, null, 'same'], '/leave': [302, `${far.base}/far`] },
    nearHits,
  );
  const headers = { authorization: 'Bearer secret', cookie: 'a=b', 'proxy-authorization': 'Basic secret', 'x-keep': 'yes' };
  const redirect = { max: 3, allow: () => true };
  const same = await request({ url: `${near.base}/same`, headers, redirect, env: {} });
  assert.equal(same.body.toString(), 'same');
  assert.equal(nearHits[1]?.headers.authorization, 'Bearer secret');
  assert.equal(nearHits[1]?.headers.cookie, 'a=b');
  const cross = await request({ url: `${near.base}/leave`, headers, redirect, env: {} });
  assert.equal(cross.body.toString(), 'far');
  assert.equal(nearHits.at(-1)?.headers.authorization, 'Bearer secret');
  const landed = farHits[0];
  assert.equal(landed?.headers.authorization, undefined);
  assert.equal(landed?.headers.cookie, undefined);
  assert.equal(landed?.headers['proxy-authorization'], undefined);
  assert.equal(landed?.headers['x-keep'], 'yes');
});

test('request sends plain http through a proxy with an absolute-URI request line', async (t) => {
  const seen = deferred();
  const server = await startHttp(t, (req, res) => {
    seen.resolve({ url: req.url, host: req.headers.host });
    res.end('proxied');
  });
  const proxy = await startProxy({ route: { 'slack-test.example:80': `127.0.0.1:${server.port}` } });
  t.after(() => proxy.close());
  const response = await request({
    url: 'http://slack-test.example/api?x=1',
    env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` },
  });
  assert.equal(response.body.toString(), 'proxied');
  assert.deepEqual(await seen.promise, { url: '/api?x=1', host: 'slack-test.example' });
  assert.equal(proxy.requests.length, 1);
  assert.ok(proxy.requests[0]?.startsWith('GET http://slack-test.example/api?x=1 HTTP/1.1\r\n'));
  assert.match(proxy.requests[0] ?? '', /\r\nhost: slack-test\.example\r\n/i);
});

test('request skips the proxy for exempt and loopback hosts', async (t) => {
  const server = await startHttp(t, (_req, res) => res.end('direct'));
  const proxy = await startProxy({ mode: 'close' });
  t.after(() => proxy.close());
  const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, ALL_PROXY: `http://127.0.0.1:${proxy.port}` };
  const loopback = await request({ url: `${server.base}/`, env });
  assert.equal(loopback.body.toString(), 'direct');
  const exempt = await request({ url: `${server.base}/`, env: { ...env, NO_PROXY: '127.0.0.1' } });
  assert.equal(exempt.body.toString(), 'direct');
  assert.equal(proxy.requests.length, 0);
});

test('request reports a refusing proxy for https without leaking the URL', async (t) => {
  const proxy = await startProxy({ mode: 'refuse' });
  t.after(() => proxy.close());
  const error = await failure(
    request({ url: 'https://slack-test.example/api?token=xoxb-secret', env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } }),
  );
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The proxy refused the connection to the server (HTTP/1.1 407 Proxy Authentication Required)');
  assertSafe(error, ['xoxb-secret', '/api', 'slack-test.example']);
});

test('request reaches an https server directly and through a CONNECT tunnel', async (t) => {
  const server = await startHttps(t, (_req, res) => res.end('secure'));
  const direct = await request({ url: `https://127.0.0.1:${server.port}/x`, tlsOptions: { ca: certificate.cert }, env: {} });
  assert.equal(direct.body.toString(), 'secure');
  const proxy = await startProxy({ route: { 'slack-test.example:443': `127.0.0.1:${server.port}` } });
  t.after(() => proxy.close());
  const tunneled = await request({
    url: 'https://slack-test.example/x',
    tlsOptions: { ca: certificate.cert },
    env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
  });
  assert.equal(tunneled.status, 200);
  assert.equal(tunneled.body.toString(), 'secure');
  assert.deepEqual(proxy.requests, [CONNECT_HEAD('slack-test.example:443')]);
  assert.deepEqual(server.names, [false, 'slack-test.example']);
});

test('request cancels a hanging request as unsure once the request was written', async (t) => {
  const received = deferred();
  const closed = deferred();
  const server = await startHttp(t, (req) => {
    req.socket.once('close', () => closed.resolve());
    received.resolve();
  });
  const controller = new AbortController();
  const pending = failure(request({ url: `${server.base}/slow?token=secret-token`, signal: controller.signal, env: {} }));
  await received.promise;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const error = await pending;
  assert.equal(error.kind, 'unsure');
  assert.equal(error.written, true);
  assert.equal(error.text, 'The request was cancelled');
  assertSafe(error, ['secret-token', '/slow']);
  await closed.promise;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('request cancels as unsent while the connection is still being set up', async (t) => {
  const connected = deferred();
  const silent = await startTcp(t, (socket) => {
    socket.once('data', () => connected.resolve());
  });
  const controller = new AbortController();
  const pending = failure(request({ url: `https://127.0.0.1:${silent.port}/`, signal: controller.signal, env: {} }));
  await connected.promise;
  controller.abort();
  const error = await pending;
  assert.equal(error.kind, 'unsent');
  assert.equal(error.written, false);
  assert.equal(error.text, 'The request was cancelled');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('request removes its abort listener after success and after failure', async (t) => {
  const server = await startHttp(t, (_req, res) => res.end('ok'));
  const controller = new AbortController();
  const response = await request({ url: `${server.base}/`, signal: controller.signal, env: {} });
  assert.equal(response.status, 200);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const port = await closedPort();
  await failure(request({ url: `http://127.0.0.1:${port}/`, signal: controller.signal, env: {} }));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
});

test('request rejects an already aborted signal without connecting', async (t) => {
  let connections = 0;
  const server = await startTcp(t, () => {
    connections += 1;
  });
  const controller = new AbortController();
  controller.abort();
  const pending = request({ url: `http://127.0.0.1:${server.port}/`, signal: controller.signal, env: {} });
  assert.ok(pending instanceof Promise);
  const error = await failure(pending);
  assert.equal(error.kind, 'unsent');
  assert.equal(error.text, 'The request was cancelled');
  assert.equal(connections, 0);
});
