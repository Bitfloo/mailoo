# Contributing to Mailoo

Thank you for your interest in contributing! This guide will help you get started.

Issues and pull requests belong on [bitfloo/mailoo](https://github.com/bitfloo/mailoo).
By contributing, you agree that your contributions are licensed under
LGPL-3.0-or-later (see [LICENSE](LICENSE) and [COPYING](COPYING)).

## Getting Started

1. Fork [bitfloo/mailoo](https://github.com/bitfloo/mailoo)
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/mailoo.git
   cd mailoo
   ```
3. Install dependencies:
   ```bash
   pnpm install
   pnpm build
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feat/your-feature
   ```

## Development

### Prerequisites

- **Node.js** >= 24.0.0
- **pnpm** 12 (see `packageManager` in `package.json`)

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start in watch mode (auto-reload) |
| `pnpm build` | Build for production |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Run ESLint with auto-fix |
| `pnpm format` | Format code with Biome |
| `pnpm format:check` | Check formatting |
| `pnpm check` | Run both Biome and ESLint |
| `pnpm test` | Unit tests (in-process; no mail server) |
| `pnpm test:integration` | Protocol tests against **GreenMail** (test IMAP/SMTP server in Docker) |
| `pnpm test:e2e` | Build and pack Mailoo, install locked production dependencies, and exercise CLI and stdio MCP against GreenMail |
| `pnpm test:all` | Unit plus GreenMail |
| `pnpm ci:local` | Lint, typecheck, unit; GreenMail when Docker is up (`pnpm ci:local -- --image` also builds) |
| `pnpm ci:release` | Lint, typecheck, unit and GreenMail, including the packed release journey; fails if Docker is unavailable |

`pnpm test:integration` needs Docker. `pnpm ci:local` skips that lane when Docker
is down (lefthook pre-push uses the same script). On a **pull request** to
`develop`, GitHub Actions runs the `ci.yml` jobs `Check, typecheck, test`,
`Integration tests` (linux GreenMail), `Docker build` and
`Public commit and pull request text`, plus CodeQL. Pushing a topic branch
starts none of them; CodeQL also runs on pushes to `develop` and weekly.
`node dist/main.js test` / `mailoo test` is a live-account connection probe, not Vitest.

The release workflow runs `pnpm ci:release` before publishing. npm, the MCP
Registry and aliases require that verification to succeed, including manual
runs with `skip-npm`. The packed journey runs with a temporary home and XDG
directories, no source files or dev dependencies, and no personal mail accounts.
It covers reading without changing flags, draft preview and delivery, reply
threading, attachment containment, read-only enforcement and process shutdown.

### Code Style

- **Formatter:** [Biome](https://biomejs.dev/) — handles formatting and import organization
- **Linter:** [ESLint](https://eslint.org/) with Airbnb Extended + TypeScript strict rules
- Run `pnpm check` before committing to catch issues

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/).
Cocogitto (`cog`) verifies the format. Messages must not contain file paths
from your own machine or names of internal tools. A commit-msg hook and a
pull request check reject them. The pattern lives in
`scripts/check-public-git-log.sh` (see `.claude/rules/public-git.md`).

```
feat: add calendar event parsing
fix: handle null subject in email headers
docs: update configuration guide
refactor: extract connection retry logic
test: add rate limiter unit tests
```

Do not put file paths from your own machine or names of internal tools in the
subject or body. Do not rewrite commits that are already on GitHub.

Releases: `package.json` `version`, tags `v*`, `CHANGELOG.md`
(cocogitto). First Mailoo release is **0.1.0**. Cut a release, not every docs
PR, with `cog bump --patch`: the next patch version. Do not use
`cog bump --auto`: cocogitto 7 moves a 0.x version to the next minor for any
`feat` commit, so 0.3.1 would become 0.4.0. Use `cog bump --minor` only when
you intentionally start a new minor line, and `cog bump --major` for a breaking
MCP API change. The pre-bump hooks in `cog.toml` move the README Docker image
tag to the new minor line and link the new `CHANGELOG.md` entry from the
previous tag. Run the bump on `develop`: it commits the version and pushes
that commit as the branch `chore/v<version>`. Open a pull request from it and
merge it with a merge commit, so the commit the tag names stays in
`develop`'s history. Then push the tag with `git push origin v<version>`; the
tag starts the publish.

npm aliases: the names in `scripts/npm-aliases.txt` are static shims that start
`@bitfloo/mailoo` (`scripts/build-npm-alias.sh`). The release workflow republishes
each one at the release version, after the main package, with an exact dependency
on it (the `aliases` job; nothing waits for it, so a failure there holds back
neither the MCP Registry nor the images). A range would freeze: npx keeps the
dependencies it resolved on the first run while the alias's own version stays the
same. Trusted publishing cannot create a package, so a new name is set up once by a
maintainer from a terminal, at a released version, with npm 11.15 or newer, 2FA on
the account and a logged-in session: pick a name that is free (npm also refuses one
that differs from an existing package only by `.`, `-` or `_`, so compare the name
with the existing ones with those characters removed on both sides), add it to the
list, run
`scripts/publish-npm-aliases.sh` (npm opens a browser to confirm), then
`npm trust github <name> --file release.yml --repo Bitfloo/mailoo --allow-publish`.
The `aliases` job warns about a name that is not on npm and fails for one that is
published but not yet trusted; both leave the rest of the release alone.
`--dry-run` builds and packs without publishing.

## Project Structure

```
src/
├── main.ts              # CLI entry point
├── server.ts            # MCP server factory
├── logging.ts           # Protocol logging bridge
├── cli/                 # CLI commands (setup, test, config)
├── config/              # Config loading + validation
├── connections/         # IMAP/SMTP connection management
├── services/            # Business logic (IMAP, SMTP, calendar, etc.)
├── tools/               # MCP tool definitions
├── resources/           # MCP resource definitions
├── prompts/             # MCP prompt definitions
├── safety/              # Rate limiter + audit logging
└── types/               # TypeScript type definitions
```

## Adding a New MCP Tool

1. Create a new file in `src/tools/` (e.g., `my-feature.tool.ts`)
2. Export a default function that takes the MCP server + services
3. Use `server.registerTool()` with a human-readable `title` and a Zod `inputSchema`
4. Add tool annotations (`readOnlyHint`, `destructiveHint`, etc.) and its row in `EXPECTED_TOOL_ANNOTATIONS` (`src/tools/annotations.test.ts`)
5. Register it in `src/tools/register.ts`: read-only tools with the other
   reads, write tools inside `if (!readOnly)`. Add a read-only tool to the
   registered-tools list in
   [`docs/configuration.md`](docs/configuration.md#settingsread_only).
   A new file in `src/tools/` also needs a `vi.mock` line in
   `src/tools/register.test.ts`, like the other tool modules.
6. Run `pnpm test src/mcp-catalog.test.ts -u` and review the baseline diff.
   A changed name, input schema, or URI of an existing tool, resource, or
   prompt is a breaking change and needs a major version bump.
7. Add a one-liner to the tools table in `README.md`. Parameter-level
   behaviour belongs in [`docs/tools.md`](docs/tools.md); config keys in
   [`docs/configuration.md`](docs/configuration.md).

## Pull Request Process

Open pull requests against **`develop`** (the GitHub default branch).
`develop` is the release line: releases are cut from it and tagged `v*`.
There is no `main` branch.

1. Ensure `pnpm check`, `pnpm typecheck` and `pnpm test` pass (the pull request runs all three)
2. Update documentation if your change affects user-facing behavior
3. Write a clear PR description explaining what and why
4. Link any related issues

## Reporting Issues

- Use [GitHub Issues](https://github.com/bitfloo/mailoo/issues) for bugs and feature requests
- Use [GitHub Discussions](https://github.com/bitfloo/mailoo/discussions) for questions and ideas

## License

By contributing, you agree that your contributions will be licensed under the [LGPL-3.0-or-later License](LICENSE).
