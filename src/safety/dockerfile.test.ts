import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DOCKERFILES = ['Dockerfile', 'Dockerfile.alpine'] as const;

describe('container image', () => {
  it('pins each base image by digest and keeps stdio without a healthcheck', async () => {
    const texts = await Promise.all(
      DOCKERFILES.map(async (file) => readFile(path.join(ROOT, file), 'utf8')),
    );
    texts.forEach((text) => {
      const froms = text.split('\n').filter((line) => line.startsWith('FROM '));
      expect(froms.length).toBeGreaterThan(0);
      froms.forEach((line) => {
        expect(line).toMatch(/^FROM node:24-(slim|alpine)@sha256:[a-f0-9]{64} AS /);
      });
      expect(text).toMatch(/^USER node$/m);
      expect(text).toContain('CMD ["stdio"]');
      expect(text).not.toMatch(/^HEALTHCHECK\b/m);
      expect(text).toMatch(/^# .*stdio.*$/im);
    });
  });
});
