/**
 * Compile a nodemailer mail object into an RFC 822 buffer (RFC 2047 headers).
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export default async function compileRfc822(mail: Record<string, unknown>): Promise<Buffer> {
  const composer = new MailComposer(mail);
  const built: unknown = await composer.compile().build();
  if (Buffer.isBuffer(built)) return built;
  if (typeof built === 'string') return Buffer.from(built);
  throw new Error('MailComposer.build() did not return a Buffer');
}
