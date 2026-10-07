import net from 'node:net';

const HEAD_END = '\r\n\r\n';

function ignore() {
  return undefined;
}

function destination(route, authority) {
  const mapped = route[authority] ?? authority;
  const index = mapped.lastIndexOf(':');
  return { host: mapped.slice(0, index).replace(/^\[|\]$/g, ''), port: Number(mapped.slice(index + 1)) };
}

function readHead(client, callback) {
  const chunks = [];
  const onData = (chunk) => {
    chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const end = buffer.indexOf(HEAD_END);
    if (end === -1) return;
    client.removeListener('data', onData);
    client.pause();
    callback(buffer.subarray(0, end + HEAD_END.length).toString('latin1'), buffer.subarray(end + HEAD_END.length));
  };
  client.on('data', onData);
}

function bridge(client, upstream) {
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.resume();
}

function tunnel(client, head, rest, route) {
  const target = head.split(' ')[1] ?? '';
  const { host, port } = destination(route, target);
  const upstream = net.connect({ host, port });
  upstream.on('error', () => {
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  upstream.once('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length > 0) upstream.write(rest);
    bridge(client, upstream);
  });
}

function forward(client, head, rest, route) {
  const lines = head.split('\r\n');
  const [method, target, version] = (lines[0] ?? '').split(' ');
  let url;
  try {
    url = new URL(target ?? '');
  } catch {
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const { host, port } = destination(route, `${url.hostname}:${url.port === '' ? 80 : url.port}`);
  const upstream = net.connect({ host, port });
  upstream.on('error', () => {
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  upstream.once('connect', () => {
    upstream.write([`${method} ${url.pathname}${url.search} ${version}`, ...lines.slice(1)].join('\r\n'));
    if (rest.length > 0) upstream.write(rest);
    bridge(client, upstream);
  });
}

export async function startProxy({ mode = 'tunnel', route = {} } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', ignore);
    readHead(client, (head, rest) => {
      requests.push(head);
      if (mode === 'close') {
        client.destroy();
        return;
      }
      if (mode === 'hang') return;
      if (mode === 'refuse') {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      if (head.startsWith('CONNECT ')) tunnel(client, head, rest, route);
      else forward(client, head, rest, route);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
