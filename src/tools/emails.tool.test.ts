import type ImapService from '../services/imap.service.js';
import registerEmailsTools from './emails.tool.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
}>;

function captureNamedHandler(name: string, imap: unknown): Handler {
  let handler: Handler | undefined;
  const server = {
    tool: (toolName: string, _desc: string, _schema: unknown, _hints: unknown, fn: Handler) => {
      if (toolName === name) handler = fn;
    },
  };
  registerEmailsTools(server as never, imap as ImapService);
  if (!handler) throw new Error(`${name} handler was not registered`);
  return handler;
}

describe('search_emails date aliases', () => {
  it('maps start_date and end_date onto since and before when those are omitted', async () => {
    const searchEmails = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    const run = captureNamedHandler('search_emails', { searchEmails });

    const result = await run({
      account: 'test',
      start_date: '2026-01-01',
      end_date: '2026-02-01',
    });

    expect(result.content[0].text).toBe('No emails found matching the specified filters.');
    expect(searchEmails).toHaveBeenCalledWith(
      'test',
      '',
      expect.objectContaining({
        since: '2026-01-01',
        before: '2026-02-01',
      }),
    );
  });

  it('prefers since and before over start_date and end_date', async () => {
    const searchEmails = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    const run = captureNamedHandler('search_emails', { searchEmails });

    const result = await run({
      account: 'test',
      query: 'invoice',
      since: '2026-03-01',
      before: '2026-04-01',
      start_date: '2026-01-01',
      end_date: '2026-02-01',
    });

    expect(result.content[0].text).toBe('No emails found matching "invoice".');
    expect(searchEmails).toHaveBeenCalledWith(
      'test',
      'invoice',
      expect.objectContaining({
        since: '2026-03-01',
        before: '2026-04-01',
      }),
    );
  });
});
