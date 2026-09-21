## Description

What changed and why it matters to a clone of this repo. No operator paths,
plugin dispatch names, or model slugs (see `.claude/rules/public-git.md`).

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactor (no functional changes)

## Checklist

- [ ] My code follows the project's code style (Biome formatter + ESLint linter)
- [ ] I have run `pnpm check` and it passes
- [ ] I have run `pnpm typecheck` and it passes
- [ ] I have added tests that prove my fix/feature works (if applicable)
- [ ] I have updated documentation (if applicable)
- [ ] Commit messages pass Conventional Commits + `scripts/check-public-git-log.sh`
- [ ] Breaking MCP tool/schema/URI changes bump the major version (`cog.toml`)
- [ ] My changes generate no new warnings
