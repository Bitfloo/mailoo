import compileRfc822 from './mail-compose.js';

describe('compileRfc822', () => {
  it('RFC-2047 encodes non-ASCII subjects', async () => {
    const raw = await compileRfc822({
      from: 'sender@example.com',
      to: 'to@example.com',
      subject: 'Ünïcode – Test',
      text: 'Body',
    });
    const msg = raw.toString('utf-8');
    expect(msg).toMatch(/Subject:\s*=\?UTF-8\?[BQ]\?/i);
    expect(msg).not.toMatch(/Subject: Ünïcode/);
  });

  it('leaves ASCII subjects unencoded', async () => {
    const raw = await compileRfc822({
      from: 'sender@example.com',
      to: 'to@example.com',
      subject: 'Plain subject',
      text: 'Body',
    });
    expect(raw.toString('utf-8')).toMatch(/Subject:\s*Plain subject/i);
  });
});
