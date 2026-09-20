import net from 'node:net';

import type { AccountConfig } from '../types/index.js';
import sieveService, {
  encodePlainAuth,
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
