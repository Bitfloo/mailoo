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

`scripts/check-public-git-log.sh` owns the generic regex (commit-msg hook).
Maintainers keep private patterns out of the repo: one extended regex per
line in `.git/info/public-git-denylist` (shared by all worktrees; each line is
used verbatim, spaces included; blank lines and `#` comments are skipped), and the `PUBLIC_GIT_EXTRA_FORBIDDEN`
repository variable for CI. A malformed pattern fails the check. Categories:

- Operator machine paths and knowledge-tree names
- Plugin dispatch names
- Model slugs used as routing instructions
- Review jargon such as “slop” or “ship bar” as the **subject** (fine in `.claude/` files)

`CLAUDE.md` may tell agents in this clone to use the project agents rather
than same-named plugin agents. That file is for agents, not for the git log.

## Versioning

Cocogitto (`cog.toml`): tags `v*`, `CHANGELOG.md`, `package.json` version.
`from_latest_tag = true` — upstream email-mcp tags are not Mailoo releases.
Bump with `cog bump --auto` (or `--minor` / `--patch`) on `main`/`develop`
when you **intend** a release. Do not bump for docs-only work.
MCP tool/schema/URI changes need a **major** bump (`CLAUDE.md`, `cog.toml`).
`server.json` `version` and each `packages[].version` track `package.json`
(`scripts/bump-server-json-version.sh`).

## Agents

| Job | Agent |
|---|---|
| PR title/body, unpushed log | `oss-pr-steward` |
| Pre-push: log + slop + readiness slice | `oss-push-gate` |
| README/install honesty | `oss-public-face` |
| Fileset/CI/license | `oss-repo-readiness` |
| Test detection | `test-auditor` (not a PR story) |

Do not rewrite published history. New commits must pass the hook.
