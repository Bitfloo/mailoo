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
- **pnpm** 9 (see `packageManager` in `package.json`)

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
| `pnpm test:all` | Unit plus GreenMail |
| `pnpm ci:local` | Lint, typecheck, unit; GreenMail when Docker is up (`pnpm ci:local -- --image` also builds) |

`pnpm test:integration` needs Docker. `pnpm ci:local` skips that lane when Docker
is down (lefthook pre-push uses the same script). GitHub Actions runs linux
GreenMail and a Docker build on **pull requests**, not on every operator push.
`node dist/main.js test` / `mailoo test` is a live-account connection probe, not Vitest.

### Code Style

- **Formatter:** [Biome](https://biomejs.dev/) — handles formatting and import organization
- **Linter:** [ESLint](https://eslint.org/) with Airbnb Extended + TypeScript strict rules
- Run `pnpm check` before committing to catch issues

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/).
Cocogitto (`cog`) verifies the format. Lefthook also rejects messages that
would leak operator paths or plugin dispatch names on public GitHub
(`.claude/rules/public-git.md`).

```
feat: add calendar event parsing
fix: handle null subject in email headers
docs: update configuration guide
refactor: extract connection retry logic
test: add rate limiter unit tests
```

Do not name internal plugins, model slugs, or machine paths in the subject
or body. Do not rewrite commits that are already on GitHub.

Releases: `package.json` `version`, annotated tags `v*`, `CHANGELOG.md`
(cocogitto). First Mailoo release is **0.1.0**. Use `cog bump --auto` when
you mean to cut a version — not for every docs PR.

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
3. Use `server.tool()` with Zod schemas for input validation
4. Add tool annotations (`readOnlyHint`, `destructiveHint`, etc.)
5. Register it in `src/tools/register.ts`
6. Add a one-liner to the tools table in `README.md`. Parameter-level
   behaviour belongs in [`docs/tools.md`](docs/tools.md); config keys in
   [`docs/configuration.md`](docs/configuration.md).

## Pull Request Process

Open pull requests against **`develop`** (the GitHub default branch).
`main` is the release line and is kept in sync with `develop`.

1. Ensure `pnpm check` and `pnpm typecheck` pass
2. Update documentation if your change affects user-facing behavior
3. Write a clear PR description explaining what and why
4. Link any related issues

## Reporting Issues

- Use [GitHub Issues](https://github.com/bitfloo/mailoo/issues) for bugs and feature requests
- Use [GitHub Discussions](https://github.com/bitfloo/mailoo/discussions) for questions and ideas

## License

By contributing, you agree that your contributions will be licensed under the [LGPL-3.0-or-later License](LICENSE).
