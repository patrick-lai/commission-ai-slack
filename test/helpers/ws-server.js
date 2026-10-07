import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { encodeFrame, FrameParser } from '../../src/ws.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_SERVER_PAYLOAD = 64 * 1024 * 1024;

function ignore() {
  return undefined;
}

class Connection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.headers = request.headers;
    this.url = request.url;
    this.frames = [];
    this.closeCode = null;
    this.answerClose = true;
    this.closeSent = false;
    this.parser = new FrameParser({ maxPayloadBytes: MAX_SERVER_PAYLOAD });
    this.fragments = [];
    this.fragmenting = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('error', ignore);
    socket.on('end', () => socket.end());
    socket.on('close', () => this.emit('close', { code: this.closeCode }));
  }

  feed(chunk) {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      this.frames.push({ opcode: frame.opcode, masked: frame.masked, fin: frame.fin, mask: frame.mask });
      this.handle(frame);
    }
  }

  handle(frame) {
    if (frame.opcode === 1 || frame.opcode === 0) {
      if (frame.opcode === 1) this.fragments = [];
      this.fragments.push(frame.payload);
      if (frame.fin) {
        const text = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.emit('message', text);
      }
      return;
    }
    if (frame.opcode === 9) this.emit('ping', frame.payload);
    if (frame.opcode === 10) this.emit('pong', frame.payload);
    if (frame.opcode === 8) this.handleClose(frame.payload);
  }

  handleClose(payload) {
    this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    this.emit('closing', { code: this.closeCode });
    if (this.answerClose) {
      if (!this.closeSent) this.sendClose(this.closeCode === 1005 ? 1000 : this.closeCode);
      this.socket.end();
    }
  }

  sendRaw(buffer) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(buffer);
    return true;
  }

  sendFrame({ opcode, payload = Buffer.alloc(0), fin = true }) {
    return this.sendRaw(encodeFrame({ opcode, payload, fin }));
  }

  sendText(text) {
    return this.sendFrame({ opcode: 1, payload: Buffer.from(text, 'utf8') });
  }

  sendBinary(payload) {
    return this.sendFrame({ opcode: 2, payload });
  }

  sendPing(payload = Buffer.alloc(0)) {
    return this.sendFrame({ opcode: 9, payload });
  }

  sendPong(payload = Buffer.alloc(0)) {
    return this.sendFrame({ opcode: 10, payload });
  }

  sendClose(code = 1000, reason = '') {
    this.closeSent = true;
    const payload = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, 'utf8')]);
    return this.sendFrame({ opcode: 8, payload });
  }

  terminate() {
    this.socket.destroy();
  }
}

export async function startWsServer({ onConnection, response, tls } = {}) {
  const connections = [];
  const handler = (_request, reply) => {
    reply.statusCode = 404;
    reply.end();
  };
  const server = tls === undefined ? http.createServer(handler) : https.createServer(tls, handler);
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', ignore);
    if (!request.url.startsWith('/link')) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
    const standard = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    const custom = response === undefined ? undefined : response({ accept, standard, request });
    const reply = custom === undefined ? standard : custom;
    const connection = new Connection(socket, request);
    connections.push(connection);
    if (reply !== false) socket.write(reply);
    if (onConnection !== undefined) onConnection(connection);
    if (head.length > 0) connection.feed(head);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const scheme = tls === undefined ? 'ws' : 'wss';
  return {
    url: `${scheme}://127.0.0.1:${port}/link?ticket=secret-ticket`,
    port,
    connections,
    async close() {
      for (const connection of connections) connection.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
