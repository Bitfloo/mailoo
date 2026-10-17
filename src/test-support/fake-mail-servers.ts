/** Local stand-ins on 127.0.0.1 for the servers a scheduler check connects to. */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

export interface FakeSmtp {
  port: number;
  auths: string[];
  openSockets: () => number;
  close: () => Promise<void>;
}

export interface FakeImap {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

export interface TokenEndpoint {
  url: string;
  close: () => Promise<void>;
}

async function listenLocal(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeLocal(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** Speaks as much ESMTP as nodemailer needs and records each AUTH line, decoded. */
export async function startFakeSmtp(): Promise<FakeSmtp> {
  const auths: string[] = [];
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let partial = '';
    let inData = false;
    const reply = (line: string) => {
      socket.write(`${line}\r\n`);
    };
    const handle = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          reply('250 2.0.0 queued');
        }
        return;
      }
      const [verb = '', mechanism = '', initial = ''] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          reply('250-fake.example.test');
          reply('250 AUTH PLAIN XOAUTH2');
          break;
        case 'AUTH':
          auths.push(`${mechanism} ${Buffer.from(initial, 'base64').toString('utf8')}`);
          reply('235 2.7.0 accepted');
          break;
        case 'DATA':
          inData = true;
          reply('354 end with a dot');
          break;
        case 'QUIT':
          reply('221 bye');
          socket.end();
          break;
        default:
          reply('250 OK');
      }
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const lines = `${partial}${chunk}`.split('\r\n');
      partial = lines.pop() ?? '';
      lines.forEach(handle);
    });
    reply('220 fake.example.test ESMTP');
  });
  const port = await listenLocal(server);
  return {
    port,
    auths,
    openSockets: () => open.size,
    close: async () => {
      open.forEach((socket) => {
        socket.destroy();
      });
      await closeLocal(server);
    },
  };
}

/** Counts connections and turns each away, as a server that is down would. */
export async function startFakeImap(): Promise<FakeImap> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.end('* BYE not accepting connections\r\n');
  });
  const port = await listenLocal(server);
  return { port, connections: () => connections, close: async () => closeLocal(server) };
}

export async function startTokenEndpoint(): Promise<TokenEndpoint> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'access-from-token-endpoint', expires_in: 3600 }));
  });
  const port = await listenLocal(server);
  return { url: `http://127.0.0.1:${port}/token`, close: async () => closeLocal(server) };
}
