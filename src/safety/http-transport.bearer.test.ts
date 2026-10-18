import { timingSafeEqual } from 'node:crypto';

import { TOKEN } from '../test-support/http-transport-harness.js';
import { bearerAuthorizationMatches } from './http-transport.js';

describe('bearerAuthorizationMatches', () => {
  it('accepts the configured token with a case-insensitive scheme', () => {
    expect(bearerAuthorizationMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a same-length token that differs by one character', () => {
    const wrong = `${TOKEN.slice(0, -1)}2`;
    expect(wrong.length).toBe(TOKEN.length);
    expect(bearerAuthorizationMatches(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  it('rejects a duplicated Authorization header', () => {
    expect(bearerAuthorizationMatches([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`], TOKEN)).toBe(false);
  });

  it('compares a different-length token with equal-sized buffers', () => {
    const sizes: number[] = [];
    const matches = bearerAuthorizationMatches('Bearer short', TOKEN, (left, right) => {
      sizes.push(left.byteLength, right.byteLength);
      return timingSafeEqual(left, right);
    });
    expect(matches).toBe(false);
    expect(sizes).toEqual([Buffer.byteLength(TOKEN), Buffer.byteLength(TOKEN)]);
  });

  // The equal-sized comparison runs against a zero buffer, so its result alone
  // must not admit a token of another length.
  it('should refuse a different-length token even when the byte comparison passes', () => {
    expect(bearerAuthorizationMatches('Bearer short', TOKEN, () => true)).toBe(false);
  });
});
