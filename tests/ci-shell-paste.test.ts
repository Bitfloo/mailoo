import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shellPastes } from './workflow-scan.js';
import { workflowDir, workflowFiles } from './workflow-yaml.js';

describe('workflow shell input', () => {
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: values are workflow lines with GitHub expressions, not JS templates
  it.each([
    'run: echo "${{ github.ref_name }}"',
    'run: git tag -d "${{ github.ref }}"',
    'run: echo "${{ github.head_ref }}"',
    'run: echo "${{ github.base_ref }}"',
    'run: echo "${{ github.event.pull_request.title }}"',
    'run: bash stamp.sh "${{ inputs.version }}"',
    'run: |\n  echo "${{\n    github.head_ref }}"',
    'run: |\n  cat <<EOF\n  REF: ${{ github.ref }}\n  EOF',
    '- run: |\n    echo "${{\n      github.head_ref }}"',
    '- run: |\n    cat <<EOF\n    REF: ${{ github.ref }}\n    EOF',
    'run: |\n  echo ok\n\n  cat <<EOF\n  REF: ${{ github.ref }}\n  EOF',
    'run: echo "${{ format(\'v{0}\', github.head_ref) }}"',
    'run: echo "${{ fromJSON(inputs.matrix).name }}"',
    'script: core.info("${{ github.head_ref }}")',
    'script: core.info("REF: ${{ github.head_ref }}")',
    'with:\n  script: |\n    const c = {\n      BRANCH: "${{ github.head_ref }}",\n    };',
    'with:\n  script: |\n    core.info("${{\n      github.head_ref }}")',
    'run: echo "${{ github.event[\'pull_request\'].title }}"',
    'run: echo "${{ github[\'head_ref\'] }}"',
    'run: echo "${{ inputs[\'version\'] }}"',
    'with:\n  args: release ${{ github.head_ref }}',
  ])('should flag %j as an untrusted expression pasted into code', (yaml) => {
    expect(shellPastes(yaml)).not.toEqual([]);
  });

  it.each([
    'GITHUB_REF_NAME: ${{ github.ref_name }}',
    'K8S_NS: ${{ inputs.namespace }}',
    "if: ${{ github.ref == 'refs/heads/develop' }}",
    'group: ${{ github.workflow }}-${{ github.ref }}',
    'run: echo "${{ github.ref_type }}"',
    'run: echo "${{ github.event_name }}"',
    'run: echo "${{ github[\'ref_type\'] }}"',
    '  run: echo "$REF"\n  env:\n    REF: ${{ github.ref }}',
  ])('should pass %j as a value no shell or script parses', (yaml) => {
    expect(shellPastes(yaml)).toEqual([]);
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of workflow lines

  it('should expand inputs, event fields and ref names only in if:, env: and group: lines', () => {
    const inline = workflowFiles().flatMap((name) =>
      shellPastes(readFileSync(join(workflowDir, name), 'utf8')).map((text) => `${name}: ${text}`),
    );
    expect(inline).toEqual([]);
  });
});
