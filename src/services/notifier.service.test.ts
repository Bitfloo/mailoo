import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import { resolveWebhookUrl } from '../safety/validation.js';
import NotifierService, { postWebhook } from './notifier.service.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '192.0.2.10', family: 4 }]),
}));

/** Webhook dispatch continues after alert() returns; flush that turn before asserting. */
async function flushWebhook(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Localhost delivery is immediate. Past this, the POST did not use the checked address. */
const WEBHOOK_DELIVERY_BOUND_MS = 500;

/** A followed redirect would open a second localhost request inside this window. */
const REDIRECT_FOLLOW_WINDOW_MS = 50;

async function listenOnLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected a loopback port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function restorePublicLookup(): void {
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockImplementation(async () => [{ address: '192.0.2.10', family: 4 }] as never);
}

describe('NotifierService webhook payload', () => {
  it('includes uid, messageId, folder, and hasAttachments', async () => {
    let raw = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        raw = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://127.0.0.1:${port}/alert`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
      });

      await notifier.alert({
        account: 'work',
        sender: { name: 'Ada', address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
        uid: '42',
        messageId: '<mid@example.com>',
        folder: 'INBOX',
        hasAttachments: true,
      });

      await vi.waitFor(
        () => {
          expect(raw.length).toBeGreaterThan(0);
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body.uid).toBe('42');
      expect(body.messageId).toBe('<mid@example.com>');
      expect(body.folder).toBe('INBOX');
      expect(body.hasAttachments).toBe(true);
      expect(body.account).toBe('work');
    } finally {
      await closeServer(server);
    }
  });

  it('does not follow a webhook redirect', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(302, { Location: '/other' });
      res.end();
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://127.0.0.1:${port}/hook`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
      });
      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
      });
      await vi.waitFor(
        () => {
          expect(hits).toEqual(['/hook']);
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
      await new Promise((resolve) => {
        setTimeout(resolve, REDIRECT_FOLLOW_WINDOW_MS);
      });
      expect(hits).toEqual(['/hook']);
    } finally {
      await closeServer(server);
    }
  });

  it('does not post to a metadata address', async () => {
    const request = vi.spyOn(http, 'request');
    const notifier = new NotifierService({
      desktop: false,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: 'http://169.254.169.254/latest/meta-data/',
      webhookEvents: ['normal'],
    });

    await notifier.alert({
      account: 'work',
      sender: { address: 'ada@example.com' },
      subject: 'Hello',
      priority: 'normal',
    });

    await flushWebhook();
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('posts to a loopback webhook when private targets are allowed', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200);
      res.end();
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://127.0.0.1:${port}/hook`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
      });

      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
      });

      await vi.waitFor(
        () => {
          expect(hits).toEqual(['/hook']);
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
    } finally {
      await closeServer(server);
    }
  });

  it('does not post when the webhook host resolves to a private address', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never);
    const request = vi.spyOn(https, 'request');

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: 'https://hooks.example.com/alert',
        webhookEvents: ['normal'],
      });

      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
      });

      await flushWebhook();
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      restorePublicLookup();
    }
  });

  it('posts to the address the connect lookup returned', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    let raw = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        raw = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://hooks.example.com:${port}/hook`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
      });
      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
      });
      await vi.waitFor(
        () => {
          expect(raw).toContain('"account":"work"');
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
    } finally {
      await closeServer(server);
      restorePublicLookup();
    }
  });

  it('refuses the connection when a later lookup returns a loopback address', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    const url = `http://hooks.example.com:${address.port}/hook`;
    const answers = [['192.0.2.10'], ['127.0.0.1']];
    const resolveName = async (): Promise<readonly string[]> => answers.shift() ?? ['127.0.0.1'];

    try {
      await expect(resolveWebhookUrl(url, { lookup: resolveName })).resolves.toBeUndefined();
      // Bounds a connect that ignored the checked address. The refusal itself is immediate.
      await expect(
        postWebhook(url, '{}', { lookup: resolveName, signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow(/loopback or private/);
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('refuses the connection when any looked-up address is loopback', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200);
      res.end();
    });
    const port = await listenOnLoopback(server);
    const url = `http://hooks.example.com:${port}/hook`;
    const answers = [['192.0.2.10'], ['192.0.2.10', '127.0.0.1']];
    const resolveName = async (): Promise<readonly string[]> => answers.shift() ?? ['127.0.0.1'];

    try {
      await expect(resolveWebhookUrl(url, { lookup: resolveName })).resolves.toBeUndefined();
      await expect(
        postWebhook(url, '{}', { lookup: resolveName, signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow(/loopback or private/);
      expect(hits).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});
