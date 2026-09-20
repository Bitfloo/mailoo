import NotifierService from './notifier.service.js';

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

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.uid).toBe('42');
    expect(body.messageId).toBe('<mid@example.com>');
    expect(body.folder).toBe('INBOX');
    expect(body.hasAttachments).toBe(true);
    expect(body.account).toBe('work');

    vi.unstubAllGlobals();
  });
});
