# Agents

Project subagents live in `.cursor/agents/` (this clone). Cursor Cloud has no
`~/.cursor/agents/` — use these files, not a machine-local copy.

| Agent | When |
|---|---|
| `test-auditor` | Existing tests: do they catch a defect? |
| `test-smith` | Write tests. Do not grade your own suite. |
| `oss-repo-readiness` | Docs/CI/license/leaks vs this tree. |
| `oss-public-face` | README/install/attribution for GitHub. |
| `oss-pr-steward` | Unpushed commit log and PR body. |
| `oss-push-gate` | Before `git push`: public log + slop. |

Rubrics: `.claude/rules/testing-doctrine.md`, `.claude/rules/public-git.md`.
Runners: `pnpm ci:local` (lint + unit; GreenMail if Docker), `pnpm test`,
`pnpm test:integration`, `pnpm test:all`. `mailoo test` is a live-account
probe, not Vitest.

## Cursor Cloud specific instructions

- Node.js ≥ 24, pnpm 9. Install: `.cursor/environment.json` `install`.
- `pnpm ci:local` (skip GreenMail unless Docker is in the VM).
- Before push: `bash scripts/check-public-git-log.sh --range origin/develop..HEAD`
  and `@oss-push-gate`. Do not rewrite published history.
- Brand files on the operator laptop are absent here. `oss-public-face` abstains
  on mission claims.
- Do not commit `.cbc/` or `docs/plans/`.
