/**
 * initialize advertises what the server actually implements. listChanged
 * stays; subscribe does not, because there is no resources/subscribe handler.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import createServer from './server.js';

describe('server capabilities', () => {
  it('should not advertise resources.subscribe', async () => {
    const server = createServer();
    const client = new Client({ name: 'mailoo-capabilities', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const resources = client.getServerCapabilities()?.resources;
      expect(resources?.subscribe).toBeUndefined();
      expect(resources?.listChanged).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

// download_attachment and export_email return the metadata and the base64 in separate blocks; a
// client that reads structuredContent instead of content lost the file.
describe('structured output', () => {
  it('should carry every text block of a result in structuredContent.summary', async () => {
    const server = createServer();
    server.registerTool('two_blocks', { title: 'Two Blocks', inputSchema: {} }, async () => ({
      content: [
        { type: 'text' as const, text: '{"filename":"a.pdf"}' },
        { type: 'text' as const, text: '--- Base64 Content ---\nJVBERi0x' },
      ],
    }));
    const client = new Client({ name: 'mailoo-structured', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'two_blocks', arguments: {} });
      expect(result.structuredContent).toEqual({
        ok: true,
        summary: '{"filename":"a.pdf"}\n--- Base64 Content ---\nJVBERi0x',
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
