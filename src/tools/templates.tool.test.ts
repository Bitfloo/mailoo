import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import type TemplateService from '../services/template.service.js';
import { registerTemplateWriteTools } from './templates.tool.js';

const { log } = vi.hoisted(() => ({
  log: vi.fn(),
}));

vi.mock('../safety/audit.js', () => ({
  default: { log },
}));

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
}>;

function captureApplyTemplate(): Handler {
  let handler: Handler | undefined;
  const templateService = {
    applyTemplate: vi.fn().mockResolvedValue({ subject: 'Hi', body: 'Hello' }),
    directory: '/tmp/mailoo-templates',
  };
  const imap = {
    saveDraft: vi.fn().mockResolvedValue({ id: 7, mailbox: 'Drafts' }),
  };
  const smtp = {
    sendEmail: vi.fn().mockResolvedValue({ messageId: '<m@example.com>' }),
  };
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      if (name === 'apply_template') handler = fn;
    },
  };
  registerTemplateWriteTools(
    server as never,
    templateService as unknown as TemplateService,
    imap as unknown as ImapService,
    smtp as unknown as SmtpService,
  );
  if (!handler) throw new Error('apply_template handler was not registered');
  return handler;
}

describe('apply_template audit log', () => {
  beforeEach(() => {
    log.mockReset();
  });

  it('reports an error when the audit log fails after a draft is saved', async () => {
    log.mockRejectedValue(new Error('audit disk full'));
    const run = captureApplyTemplate();
    const result = await run({
      account: 'personal',
      template: 'greeting',
      variables: { name: 'Ada' },
      action: 'draft',
      to: ['ada@example.com'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('audit disk full');
  });

  it('reports an error when the audit log fails after a send', async () => {
    log.mockRejectedValue(new Error('audit disk full'));
    const run = captureApplyTemplate();
    const result = await run({
      account: 'personal',
      template: 'greeting',
      variables: { name: 'Ada' },
      action: 'send',
      to: ['ada@example.com'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('audit disk full');
  });

  it('waits for the audit log before reporting a saved draft', async () => {
    let resolveAudit: () => void = () => {};
    log.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          resolveAudit = resolve;
        }),
    );
    const run = captureApplyTemplate();
    let settled = false;
    const pending = run({
      account: 'personal',
      template: 'greeting',
      variables: { name: 'Ada' },
      action: 'draft',
      to: ['ada@example.com'],
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    resolveAudit();
    const result = await pending;
    expect(result.content[0].text).toContain('Draft saved');
  });
});
