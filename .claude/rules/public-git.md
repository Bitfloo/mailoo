# Public GitHub log

Mailoo is a **public** LGPL repo. Issue comments, PR bodies, and **every commit
subject/body** are world-readable. Write them as if a stranger clones today.

## Required

- Conventional Commits (`feat:`, `fix:`, `docs:`, …). Lefthook runs `cog verify`.
- Subject: what changed in **this tree** and why it matters to a user or
  contributor — not which agent, model, or plugin wrote it.
- Comments and CI notes carry **WHY** (incident or constraint). Do not restate
  the next line. Do not delete a WHY that still applies (`testing-doctrine.md`
  agent rule 6).

## Forbidden in commit messages, PR titles, and PR bodies

Patterns are enforced by `scripts/check-public-git-log.sh` (commit-msg hook).

- Operator paths (`/Users/`, `/home/`, `AI-DATA`, `PROJEKTY`, `_knowledge/`)
- Plugin dispatch names (`cbc:test-auditor`, `cbc:test-smith`, `cbc:push-gate`)
- Model slugs (`cursor-grok`, `sonnet` as a routing instruction)
- “Slop”, “L4 twins”, “ship bar” as the **subject** (fine in `.claude/` files)

`CLAUDE.md` may name project vs plugin agents so operators do not mis-dispatch.
That file is for agents in this clone, not for the git log.

## Versioning

Cocogitto (`cog.toml`): tags `v*`, `CHANGELOG.md`, `package.json` version.
`from_latest_tag = true` — upstream email-mcp tags are not Mailoo releases.
Bump with `cog bump --auto` (or `--minor` / `--patch`) on `main`/`develop`
when you **intend** a release. Do not bump for docs-only work.
MCP tool/schema/URI changes need a **major** bump (`CLAUDE.md`, `cog.toml`).
`server.json` `version` tracks `package.json`; omit `packages[]` until npm
exists (`release.yml` jq already skips a missing array).

## Agents

| Job | Agent |
|---|---|
| PR title/body, unpushed log | `oss-pr-steward` |
| Pre-push: log + slop + readiness slice | `oss-push-gate` |
| README/install honesty | `oss-public-face` |
| Fileset/CI/license | `oss-repo-readiness` |
| Test detection | `test-auditor` (not a PR story) |

Do not rewrite published history. New commits must pass the hook.
