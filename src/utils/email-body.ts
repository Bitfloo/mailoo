/**
 * Shared body formatting for get_email / get_thread.
 *
 * For AI-friendly `text` / `stripped` output, a tiny text/plain fallback
 * must not hide a materially richer HTML alternative.
 */

export type BodyFormat = 'full' | 'text' | 'stripped';

/** Strips HTML markup and decodes common entities to produce readable plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes quoted reply chains and signatures from plain text. */
export function stripReplyChain(text: string): string {
  const lines = text.split('\n');
  const stopIdx = lines.findIndex((l) => /^--\s*$/.test(l) || /^_{3,}\s*$/.test(l));
  const relevant = stopIdx === -1 ? lines : lines.slice(0, stopIdx);
  return relevant
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * True when a "plain" part is actually a raw MIME container dump.
 * Must not treat quote separators such as `-----Original Message-----` as MIME.
 */
export function looksLikeRawMime(text: string): boolean {
  const head = text.trimStart();
  if (/^Content-Type\s*:\s*(multipart\/|message\/rfc822)/i.test(head)) return true;
  // Boundary at start-of-line followed by a MIME header — not `--` quote rules.
  return /(?:^|\r?\n)--[A-Za-z0-9'()+_,.=/?-]{1,70}\s*\r?\nContent-(Type|Transfer-Encoding|Disposition)\s*:/i.test(
    text,
  );
}

/**
 * Prefer HTML-derived text when it is materially richer than the plain alternative.
 * "Materially richer" = at least 2× the length and at least 40 extra characters.
 */
export function preferRicherPlain(plain: string | undefined, html: string | undefined): string {
  const htmlText = html ? stripHtml(html) : '';
  const plainText = plain && !looksLikeRawMime(plain) ? plain : '';
  if (!plainText) return htmlText;
  if (!htmlText) return plainText;
  if (htmlText.length >= Math.max(plainText.length * 2, plainText.length + 40)) {
    return htmlText;
  }
  return plainText;
}

/**
 * Applies the requested body format and optional character cap.
 *
 * - full:     bodyText ?? bodyHtml (skips raw MIME dumps)
 * - text:     prefers plain; uses richer HTML-derived text when the plain part is a stub
 * - stripped: like text, then removes quoted reply chains and signatures
 */
export function applyBodyFormat(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: BodyFormat,
  maxLength?: number,
): string {
  let body: string;

  if (format === 'full') {
    const plain = bodyText && !looksLikeRawMime(bodyText) ? bodyText : undefined;
    body = plain ?? bodyHtml ?? '(no content)';
  } else {
    const base = preferRicherPlain(bodyText, bodyHtml) || '(no content)';
    body = format === 'stripped' ? stripReplyChain(base) : base;
  }

  if (maxLength !== undefined && maxLength > 0 && body.length > maxLength) {
    const remaining = body.length - maxLength;
    body = `${body.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`;
  }

  return body;
}
