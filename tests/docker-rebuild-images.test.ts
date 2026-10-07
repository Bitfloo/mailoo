import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';

const workflowDir = join(repoRoot, '.github/workflows');

function goreleaserImage(yaml: string, id: string): string {
  const match = yaml.match(new RegExp(`- id: ${id}\\n[\\s\\S]*?(?=\\n  - id: |\\nrelease:)`));
  if (!match) {
    throw new Error(`missing goreleaser image ${id}`);
  }
  return match[0];
}

function yamlList(section: string, key: string): string[] {
  const match = section.match(new RegExp(`\\n {4}${key}:\\n((?: {6}- .+\\n)+)`));
  if (!match) {
    throw new Error(`missing ${key}`);
  }
  return match[1]
    .trimEnd()
    .split('\n')
    .map((line) => {
      const raw = line.replace(/^\s*- /, '');
      return raw.startsWith('"') ? raw.slice(1, -1) : raw;
    });
}

function yamlScalar(section: string, key: string): string {
  const match = section.match(new RegExp(`\\n {4}${key}: (\\S+)`));
  if (!match) {
    throw new Error(`missing ${key}`);
  }
  const raw = match[1];
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

/** Shell fragment in docker-rebuild.yml for one GoReleaser tag template. sha-* is release-only. */
const RELEASE_TAG_IN_REBUILD: Record<string, string> = {
  '{{ .Version }}': '"${IMAGE}:${V}"',
  '{{ .Version }}-bookworm': '"${IMAGE}:${V}-bookworm"',
  '{{ .Version }}-alpine': '"${IMAGE}:${V}-alpine"',
  '{{ .Major }}.{{ .Minor }}': '"${IMAGE}:${MAJOR}.${MINOR}"',
  '{{ .Major }}.{{ .Minor }}-bookworm': '"${IMAGE}:${MAJOR}.${MINOR}-bookworm"',
  '{{ .Major }}.{{ .Minor }}-alpine': '"${IMAGE}:${MAJOR}.${MINOR}-alpine"',
  '{{ .Major }}': '"${IMAGE}:${MAJOR}"',
  '{{ .Major }}-bookworm': '"${IMAGE}:${MAJOR}-bookworm"',
  '{{ .Major }}-alpine': '"${IMAGE}:${MAJOR}-alpine"',
  bookworm: '"${IMAGE}:bookworm"',
  '{{ if not .Prerelease }}latest{{ end }}': '"${IMAGE}:latest"',
  '{{ if not .Prerelease }}alpine{{ end }}': '"${IMAGE}:alpine"',
};

describe('docker rebuild images', () => {
  it('uses the release tag names, Dockerfiles, and architectures', () => {
    const goreleaser = readFileSync(join(repoRoot, '.goreleaser.yaml'), 'utf8');
    const workflow = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    for (const id of ['mailoo-debian', 'mailoo-alpine']) {
      const image = goreleaserImage(goreleaser, id);
      expect(workflow, id).toContain(`file: ${yamlScalar(image, 'dockerfile')}\n`);
      expect(yamlList(image, 'platforms')).toEqual(['linux/amd64', 'linux/arm64']);
      for (const template of yamlList(image, 'tags')) {
        if (template.includes('ShortCommit')) {
          expect(workflow).not.toContain('sha-${{');
          continue;
        }
        const needle = RELEASE_TAG_IN_REBUILD[template];
        expect(needle, template).toBeTruthy();
        expect(workflow).toContain(needle);
      }
    }
    expect(workflow.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(2);
    expect(workflow).toContain('if [[ "$V" != *-* ]]');
  });
});
