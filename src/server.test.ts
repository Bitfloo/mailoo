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
