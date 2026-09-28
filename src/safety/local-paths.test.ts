import { sanitizeAttachmentFilename } from './local-paths.js';

const NAME_MAX_BYTES = 255;

describe('sanitizeAttachmentFilename', () => {
  // 200 ideographs are 600 UTF-8 bytes. NAME_MAX on Linux ext4 is 255 bytes.
  it('should keep two hundred ideographs within 255 UTF-8 bytes', () => {
    const result = sanitizeAttachmentFilename('日'.repeat(200));
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(Buffer.byteLength(result)).toBeGreaterThan(NAME_MAX_BYTES - 4);
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
    expect(result).toBe('日'.repeat(85));
  });

  // A UTF-16 slice of 200 units keeps the first half of this emoji.
  it('should keep an emoji that fits in 255 UTF-8 bytes whole', () => {
    const name = `${'a'.repeat(199)}😀`;
    const result = sanitizeAttachmentFilename(name);
    expect(result).toBe(name);
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
  });

  // 254 ASCII bytes plus a 4-byte emoji is 258 bytes, so the emoji must be dropped whole.
  it('should drop an emoji that crosses 255 UTF-8 bytes whole', () => {
    const result = sanitizeAttachmentFilename(`${'a'.repeat(254)}😀`);
    expect(result).toBe('a'.repeat(254));
    expect(result.includes('😀')).toBe(false);
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
  });

  // 90 ideographs plus ".pdf" are 274 bytes. The suffix still fits in NAME_MAX.
  it('should preserve the extension when the name exceeds 255 UTF-8 bytes', () => {
    const result = sanitizeAttachmentFilename(`${'日'.repeat(90)}.pdf`);
    expect(result).toBe(`${'日'.repeat(83)}.pdf`);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
  });
});
