import net from 'node:net';

import type { AccountConfig } from '../types/index.js';
import sieveService, {
  encodePlainAuth,
  MAX_SIEVE_SCRIPT_BYTES,
  parseCapabilityMap,
  parseListScripts,
} from './sieve.service.js';

function sieveAccount(port: number): AccountConfig {
  return {
    name: 'test',
    email: 'user@example.com',
    username: 'user@example.com',
    password: 's3cret',
    imap: {
      host: '127.0.0.1',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
      sieveHost: '127.0.0.1',
      sievePort: port,
    },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  };
}

async function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
        return;
      }
      reject(new Error('ManageSieve test server has no port'));
    });
    server.once('error', reject);
  });
}

describe('ManageSieve parsers', () => {
  it('parses LISTSCRIPTS lines including ACTIVE', () => {
    expect(parseListScripts(['"personal"', '"vacation" ACTIVE', 'OK'])).toEqual([
      { name: 'personal', active: false },
      { name: 'vacation', active: true },
    ]);
  });

  it('parses CAPABILITY atoms', () => {
    const caps = parseCapabilityMap([
      '"IMPLEMENTATION" "Cyrus timsieved"',
      '"SASL" "PLAIN"',
      '"SIEVE" "fileinto reject vacation"',
      '"STARTTLS"',
    ]);
    expect(caps.IMPLEMENTATION).toBe('Cyrus timsieved');
    expect(caps.SIEVE).toContain('fileinto');
    expect(caps.STARTTLS).toBe('');
  });

  it('encodes SASL PLAIN without embedding the password in extra wrapping', () => {
    const token = encodePlainAuth('user@example.com', 'secret');
    expect(Buffer.from(token, 'base64').toString('utf8')).toBe('\0user@example.com\0secret');
  });
});

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function countingServer(): { server: net.Server; connections: () => number } {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.write('"IMPLEMENTATION" "test"\r\n"SASL" "PLAIN"\r\nOK "ready"\r\n');
  });
  return { server, connections: () => connections };
}

describe('ManageSieve script limits', () => {
  it.each([
    [
      'put',
      async (port: number, name: string) =>
        sieveService.putScript(sieveAccount(port), name, 'keep;'),
    ],
    ['get', async (port: number, name: string) => sieveService.getScript(sieveAccount(port), name)],
    [
      'delete',
      async (port: number, name: string) => sieveService.deleteScript(sieveAccount(port), name),
    ],
    [
      'activate',
      async (port: number, name: string) => sieveService.activateScript(sieveAccount(port), name),
    ],
  ] as const)('does not open a socket for %s when the script name contains a line break', async (_label, call) => {
    const { server, connections } = countingServer();
    const port = await listen(server);
    try {
      await expect(call(port, 'ok\r\nDELETESCRIPT "other')).rejects.toThrow(/script name/i);
      expect(connections()).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('does not open a socket for a script name longer than 255 characters', async () => {
    const { server, connections } = countingServer();
    const port = await listen(server);
    try {
      await expect(
        sieveService.putScript(sieveAccount(port), 'a'.repeat(256), 'keep;'),
      ).rejects.toThrow(/script name/i);
      expect(connections()).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('does not open a socket for a script larger than 1 MiB', async () => {
    expect(MAX_SIEVE_SCRIPT_BYTES).toBe(1024 * 1024);
    const { server, connections } = countingServer();
    const port = await listen(server);
    try {
      await expect(
        sieveService.putScript(
          sieveAccount(port),
          'personal',
          'a'.repeat(MAX_SIEVE_SCRIPT_BYTES + 1),
        ),
      ).rejects.toThrow(/bytes|large|size/i);
      expect(connections()).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('opens a socket when deactivating with an empty script name', async () => {
    const { server, connections } = countingServer();
    const port = await listen(server);
    try {
      await expect(sieveService.activateScript(sieveAccount(port), '')).rejects.toThrow(
        /TLS|STARTTLS/i,
      );
      expect(connections()).toBe(1);
    } finally {
      await closeServer(server);
    }
  });
});

describe('ManageSieve TLS', () => {
  it('does not AUTHENTICATE with a password on a no-STARTTLS greeting', async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.write(
        '"IMPLEMENTATION" "test"\r\n"SASL" "PLAIN"\r\n"SIEVE" "fileinto"\r\nOK "ready"\r\n',
      );
      socket.on('data', (chunk) => {
        received.push(chunk.toString('utf8'));
      });
    });

    const port = await listen(server);
    try {
      await expect(sieveService.listScripts(sieveAccount(port))).rejects.toThrow(/STARTTLS|TLS/i);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      const wire = received.join('');
      expect(wire).not.toMatch(/AUTHENTICATE/i);
      expect(wire).not.toContain('s3cret');
      expect(wire).not.toContain(encodePlainAuth('user@example.com', 's3cret'));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
