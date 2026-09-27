import { lookup } from 'node:dns/promises';

import NotifierService from './notifier.service.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '192.0.2.10', family: 4 }]),
}));

/** Webhook dispatch continues after alert() returns; flush that turn before asserting. */
async function flushWebhook(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('NotifierService webhook payload', () => {
  it('includes uid, messageId, folder, and hasAttachments', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new NotifierService({
      desktop: false,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: 'https://hooks.example.com/alert',
      webhookEvents: ['normal'],
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

    await flushWebhook();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.uid).toBe('42');
    expect(body.messageId).toBe('<mid@example.com>');
    expect(body.folder).toBe('INBOX');
    expect(body.hasAttachments).toBe(true);
    expect(body.account).toBe('work');
    const init = fetchMock.mock.calls[0][1] as { redirect?: string; signal?: AbortSignal };
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllGlobals();
  });

  it('does not post to a metadata address', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

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
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('posts to a loopback webhook when private targets are allowed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new NotifierService({
      desktop: false,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: 'http://127.0.0.1/hook',
      webhookEvents: ['normal'],
      allowPrivateWebhooks: true,
    });

    await notifier.alert({
      account: 'work',
      sender: { address: 'ada@example.com' },
      subject: 'Hello',
      priority: 'normal',
    });

    await flushWebhook();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('does not post when the webhook host resolves to a private address', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

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
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
