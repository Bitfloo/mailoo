import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { readLimitedBody } from './http-transport.js';

function fakeRequest(chunks: Buffer[]): IncomingMessage {
  const readable = Readable.from(chunks);
  return Object.assign(readable, { headers: {} }) as IncomingMessage;
}

describe('readLimitedBody', () => {
  it('returns a body that is within the limit', async () => {
    const body = await readLimitedBody(fakeRequest([Buffer.from('{"jsonrpc":"2.0"}')]), 64);
    expect(body.toString('utf8')).toBe('{"jsonrpc":"2.0"}');
  });

  it('should return a streamed body that reaches exactly the limit', async () => {
    const body = await readLimitedBody(fakeRequest([Buffer.alloc(4), Buffer.alloc(4)]), 8);
    expect(body.length).toBe(8);
  });

  it('should read a body whose declared Content-Length equals the limit', async () => {
    const headers = { 'content-length': '8' };
    const req = Object.assign(Readable.from([Buffer.alloc(8)]), { headers }) as IncomingMessage;
    expect((await readLimitedBody(req, 8)).length).toBe(8);
  });

  it('rejects streamed bytes one past the limit', async () => {
    const req = fakeRequest([Buffer.alloc(8), Buffer.alloc(1)]);
    await expect(readLimitedBody(req, 8)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a declared Content-Length over the limit before reading the stream', async () => {
    let pulled = false;
    const readable = new Readable({
      read() {
        pulled = true;
        this.push(null);
      },
    });
    const req = Object.assign(readable, {
      headers: { 'content-length': '100' },
    }) as IncomingMessage;
    await expect(readLimitedBody(req, 8)).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBe(false);
  });

  it('should refuse a non-numeric declared Content-Length with 400 before reading', async () => {
    const headers = { 'content-length': 'abc' };
    const req = Object.assign(Readable.from([Buffer.alloc(4)]), { headers }) as IncomingMessage;

    await expect(readLimitedBody(req, 8)).rejects.toMatchObject({
      status: 400,
      message: 'Invalid Content-Length',
    });
  });

  it('should reject with the stream error when the request fails mid-body', async () => {
    const readable = new Readable({
      read() {
        this.destroy(new Error('socket reset'));
      },
    });
    const req = Object.assign(readable, { headers: {} }) as IncomingMessage;

    await expect(readLimitedBody(req, 8)).rejects.toThrow('socket reset');
  });

  // The guard answers 413 at once; reading on would pull the rest of an
  // oversized upload into a process that already refused it.
  it('should stop reading the stream once the body passes the limit', async () => {
    const req = fakeRequest([Buffer.alloc(8), Buffer.alloc(1), Buffer.alloc(8)]);

    const status = await readLimitedBody(req, 8).then(
      () => 200,
      (err: { status: number }) => err.status,
    );

    expect({ status, paused: req.isPaused() }).toEqual({ status: 413, paused: true });
  });
});
