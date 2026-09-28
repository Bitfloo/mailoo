/**
 * Nodemailer used to fetch remote URLs and OAuth tokens without checking
 * the server certificate. A loopback server with a certificate this process
 * does not trust must be refused, so a downgrade of that default fails here.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:https';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import nmfetch from 'nodemailer/lib/fetch';
import XOAuth2 from 'nodemailer/lib/xoauth2';

const execFileAsync = promisify(execFile);
const CERT_ERROR = /certificate|unable to verify|self-signed/i;

async function createUntrustedCert(): Promise<{
  cert: Buffer;
  key: Buffer;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'mailoo-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  return {
    cert: await readFile(certPath),
    key: await readFile(keyPath),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function withUntrustedHttps(run: (url: string) => Promise<void>): Promise<void> {
  const fixture = await createUntrustedCert();
  const server = createServer({ cert: fixture.cert, key: fixture.key }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
  });
  try {
    const port = await listen(server);
    await run(`https://127.0.0.1:${port}/token`);
  } finally {
    await closeServer(server);
    await fixture.cleanup();
  }
}

describe('nodemailer remote fetches', () => {
  it('should refuse a URL fetch when the TLS certificate is not trusted', async () => {
    await withUntrustedHttps(async (url) => {
      const outcome = await new Promise<{ kind: 'error' | 'end'; message: string }>((resolve) => {
        const req = nmfetch(url);
        req.resume();
        req.once('error', (err: Error) => {
          resolve({ kind: 'error', message: err.message });
        });
        req.once('end', () => {
          resolve({ kind: 'end', message: '' });
        });
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.message).toMatch(CERT_ERROR);
    });
  });

  it('should refuse an OAuth token request when the TLS certificate is not trusted', async () => {
    await withUntrustedHttps(async (url) => {
      const outcome = await new Promise<{ kind: 'error' | 'ok'; message: string }>((resolve) => {
        const oauth = new XOAuth2({
          user: 'user@example.com',
          clientId: 'client',
          clientSecret: 'secret',
          refreshToken: 'refresh',
          accessUrl: url,
        });
        oauth.generateToken((err) => {
          if (err) {
            resolve({ kind: 'error', message: err.message });
            return;
          }
          resolve({ kind: 'ok', message: '' });
        });
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.message).toMatch(CERT_ERROR);
    });
  });
});
