import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { onBlock, releaseSteps, workflowDir, workflowFiles } from './workflow-yaml.js';

const workflows = workflowFiles().map(
  (name) => [name, readFileSync(join(workflowDir, name), 'utf8')] as const,
);

/**
 * Each workflow's on: block, comment lines stripped. A filter such as paths, paths-ignore, types
 * or another branch stops a run as surely as a missing trigger, so the whole block is pinned.
 */
const ON: Record<string, string[]> = {
  'ci.yml': [
    '  pull_request:',
    '    branches: [develop]',
    '  workflow_dispatch:',
    '    inputs:',
    '      include-unit:',
    '        description: Also run lint and unit tests (lefthook already does this)',
    '        type: boolean',
    '        default: false',
  ],
  'codeql.yml': [
    '  pull_request:',
    '    branches: [develop]',
    '  push:',
    '    branches: [develop]',
    '  schedule:',
    '    - cron: "17 5 * * 1"',
    '  workflow_dispatch:',
  ],
  'docker-rebuild.yml': ['  schedule:', '    - cron: "0 6 * * 1"', '  workflow_dispatch:'],
  'docker-sha.yml': ['  workflow_dispatch:'],
  // Another trigger would pass the npm gate as a run that is not a manual dispatch, and a string
  // skip-npm would make !inputs.skip-npm false on every manual run.
  'release.yml': [
    '  push:',
    '    tags:',
    '      - "v*"',
    '  workflow_dispatch:',
    '    inputs:',
    '      version:',
    '        description: >-',
    '          Version to release (e.g. 1.2.3) — used when',
    '          triggering manually without a git tag',
    '        required: false',
    '      skip-npm:',
    '        description: Skip npm publish (e.g. already published)',
    '        type: boolean',
    '        default: false',
  ],
  'scorecard.yml': ['  schedule:', '    - cron: "20 7 * * 2"', '  branch_protection_rule:'],
};

describe('workflow rosters', () => {
  // Each roster is keyed by the files in the tree, so a new workflow fails until it is listed.
  it.each(workflows)('should trigger %s exactly as its pinned on: block says', (name, yaml) => {
    expect(releaseSteps(onBlock(yaml)).trimEnd()).toBe(ON[name]?.join('\n'));
  });
});
