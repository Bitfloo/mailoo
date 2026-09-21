# CLAUDE.md

Guidance for Claude (Code Action, managed Code Review, local Claude Code
sessions) when working in this repository.

## What this repo is

**Mailoo** is Bitfloo's public LGPL-3.0-or-later fork of email-mcp.
It is an open-source **MCP (Model Context Protocol) server** providing
comprehensive email capabilities over IMAP and SMTP. It exposes tools,
prompts, and resources to AI assistants for reading, sending,
scheduling, organising, and analysing email across multiple accounts.

- **Language / runtime**: TypeScript (ESM), Node.js ≥ 24.
- **Package manager**: pnpm 9 (do not introduce npm or yarn).
- **Transport modes**: stdio (default), Streamable HTTP.
- **License**: LGPL-3.0-or-later.
- **Public repo**: issue and PR comments are world-readable. Committed docs
  name this tree only — no plugin-internal paths, no changelog-as-comment.

See `README.md` for the feature list, `docs/` for deeper guides, and
`AGENTS.md` for the Cursor Cloud roster (`.cursor/agents/`).

## Stack and tooling

| Concern | Tool |
|---|---|
| Format / import organisation | Biome (`pnpm format`, `pnpm format:check`) |
| Lint | ESLint (Airbnb Extended + TS strict) (`pnpm lint`) |
| Combined static checks | `pnpm check` (Biome + ESLint) |
| Type-check | `pnpm typecheck` |
| Unit tests | Vitest (`pnpm test`) — include list in `vitest.config.ts` |
| Integration tests | Vitest with `vitest.config.integration.ts` (`pnpm test:integration`) — GreenMail IMAP/SMTP in Docker |
| Test agents | Project `test-auditor` / `test-smith` in `.claude/agents/` (Claude Code, `model: sonnet`) and `.cursor/agents/` (Cursor, `model: cursor-grok-4.6-xhigh` minimum). Same body; rubric: `.claude/rules/testing-doctrine.md`. After new or changed tests, run `test-auditor` in a **fresh** session on the same files (not the author). Do not dispatch `cbc:test-auditor` or `cbc:test-smith` in this repo. |
| Public OSS face | Project `oss-repo-readiness`, `oss-public-face`, `oss-pr-steward` (PR/log), `oss-push-gate` (pre-push log + slop). Cursor, `model: cursor-grok-4.6-xhigh`. Rubric: `.claude/rules/public-git.md`. Read-only. Merge and release stay in this repo (`CONTRIBUTING.md`, `cog`, goreleaser). |
| Pre-commit hooks | lefthook |
| Versioning / changelog | cocogitto (`cog.toml`, `CHANGELOG.md`, tags `v*`). Current package is `0.1.1`. On **0.1.x**, `cog bump --auto` is patch-only (`feat` uses `bump_patch`); MCP API breaks need a major bump. |
| Release | goreleaser |

Always run `pnpm ci:local` before declaring work done (lint, typecheck, unit;
GreenMail when Docker is up; `pnpm ci:local -- --image` also builds the image).
GitHub Actions does **not** repeat unit CI on operator pushes — it runs linux
GreenMail + image on pull requests, and the same on `workflow_dispatch`. Tick
`include-unit` on dispatch only when lefthook did not run. `mailoo test` /
`src/cli/test.ts` is a CLI connection probe, not Vitest.

## Conventions to follow

- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`, `ci:`). cocogitto enforces this. Use `pnpm commit`
  if unsure. Lefthook also runs `scripts/check-public-git-log.sh` — no
  operator paths or plugin dispatch names in the message (`.claude/rules/public-git.md`).
  Before `git push`, run project `oss-push-gate` (and `oss-pr-steward` if the
  log is the PR). Do not rewrite published history.
- **Branches**: GitHub default is `develop`. Topic branches off `develop`;
  PRs target `develop`. `main` is the release line, kept in sync with
  `develop` (`develop` → `main` merges).
- **Files layout**: business logic in `src/services/`, MCP wiring in
  `src/tools/`, `src/prompts/`, `src/resources/`. Keep them decoupled —
  services must be unit-testable without mocking MCP transports.
- **Workflows**: lowercase kebab-case `name:`, explicit `permissions:`
  block per workflow. Keep CI in-repo (do not call
  `codefuturist/shared-workflows`).

## What to do / not do

- **Prefer editing existing files** over creating new ones.
- **Do not** hardcode credentials, API keys, OAuth client secrets, or
  example email addresses with real domains in source or tests.
- **Do not** log passwords, OAuth tokens, or full message bodies at
  `info` or above — they may end up in user-shared logs.
- **Do not** bump `engines.node` below 24 (existing baseline).
- **Do not** add a new transport without updating both `README.md` and
  the MCP capability negotiation.
- **TypeScript**: keep `strict` on, no `any` without an explicit
  comment justifying it.
- **Async correctness**: IMAP IDLE, watcher, scheduler, and rate-limiter
  code is concurrency-sensitive. Don't fire-and-forget promises; await
  or attach `.catch(...)`.
- **Public API**: tool names, parameter schemas, and resource URIs are
  part of the MCP API surface. Renames or schema changes are breaking
  changes and need a major version bump (see `cog.toml`).

## Validation before you call it done

1. `pnpm check` — Biome + ESLint clean.
2. `pnpm typecheck` — no type errors.
3. `pnpm test` — unit tests green.
4. `pnpm test:integration` — required for IMAP/SMTP, watcher,
   scheduler, or transport changes. Needs Docker. `pnpm ci:local`
   runs it when Docker is up; GitHub runs it on pull requests.
5. For Docker-affecting changes: `pnpm docker:build` or `pnpm ci:local -- --image`.
6. For workflow changes: `actionlint` clean (`pnpm report` includes it).
