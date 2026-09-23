# Changelog

All notable changes to **Mailoo** are documented here.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

<!-- next-header -->

## [Unreleased]

- Sent IMAP APPEND after SMTP (`save_to_sent`; skipped for Gmail)
- IMAP4rev2 opt-out for broken SEARCH (e.g. Strato)
- ManageSieve tools (TLS required for PLAIN)
- `get_email_security`, attachment `savePath`, search `since`/`before`
- `read_only` also skips hooks, watcher, and the in-process scheduler
- Stdio shutdown on client stdin EOF; RFC 2047 encoded draft/Sent subjects

See [docs/configuration.md](docs/configuration.md) and
[docs/tools.md](docs/tools.md).

## [0.1.1] — 2026-09-21

- Adopt patch-only **0.1.x** versioning (`cog bump --auto` advances patch, including `feat`)

## [0.1.0] — 2026-09-20

First Mailoo release. Public LGPL-3.0-or-later fork of
[email-mcp](https://github.com/codefuturist/email-mcp) by codefuturist,
rebranded and maintained by Bitfloo. This is not an official codefuturist
project. Original copyright remains with the original authors.

- Rebrand as Mailoo (`@bitfloo/mailoo`, `mailoo` CLI, XDG dirs under `mailoo`)
- Add `COPYING` (GNU GPL-3) and `NOTICE` as required by LGPL-3
- Replace `codefuturist/shared-workflows` with in-repo GitHub Actions
- Start Mailoo versioning at 0.1.0 (do not treat upstream tags as Mailoo releases)

---

## Upstream history (email-mcp)

The following entries document the upstream project before the fork.
They are **not** Mailoo releases. Commit links point at
[codefuturist/email-mcp](https://github.com/codefuturist/email-mcp).

## Upstream unreleased ([3886bac..4e6910c](https://github.com/codefuturist/email-mcp/compare/3886bac..4e6910c))

#### ✨ Features

- **(alerts)** add notification setup diagnostics and AI-configurable alerts - ([34e288a](https://github.com/codefuturist/email-mcp/commit/34e288acb3a3330fd4eca0a583540ec877d9912c))
- **(alerts)** add urgency-based multi-channel notification system - ([b2425df](https://github.com/codefuturist/email-mcp/commit/b2425df6c917436e056e5cc8002ce684fc898694))
- **(cli)** add notify command for testing desktop notifications - ([687f7d2](https://github.com/codefuturist/email-mcp/commit/687f7d26449d97d56bd9d94b7e67f3b798b8e13e))
- **(cli)** add interactive MCP client installation command - ([e2369c7](https://github.com/codefuturist/email-mcp/commit/e2369c7f03df1e506b0bb11e0e5c471a0313ec6b))
- **(cli)** add interactive account CRUD and config edit commands - ([aaa8af5](https://github.com/codefuturist/email-mcp/commit/aaa8af501e7738cf049bd0b4a29ee74f0dbee3bb))
- **(hooks)** add customizable presets and static rule matching - ([138c08e](https://github.com/codefuturist/email-mcp/commit/138c08e0708f49e795e036e2245022fe060a0950))
- **(watcher)** add IMAP IDLE monitoring with AI triage - ([5ed0388](https://github.com/codefuturist/email-mcp/commit/5ed0388ccb0a781220407b3800723bf8191eb2f9))
- add AI-optimised email tools and context improvements - ([d7b01a4](https://github.com/codefuturist/email-mcp/commit/d7b01a48e57491d68ac605583ede6c1a92b2b70d))
- add provider-aware label management (ProtonMail/Gmail/IMAP keywords) - ([85609e5](https://github.com/codefuturist/email-mcp/commit/85609e5f181ea3c01ef26b4fe27a69bafb549141))
- add IMAP move/delete reliability and find_email_folder tool - ([3886bac](https://github.com/codefuturist/email-mcp/commit/3886bacc83eb8b4200f16695468e9029ade32c40))

#### 🐛 Bug Fixes

- **(cli)** add TTY guard and fix IMAP STARTTLS display - ([d9bca69](https://github.com/codefuturist/email-mcp/commit/d9bca695af07e311ec249379827c175e8dac483b))
- virtual folder detection and find_email_folder reliability - ([3c44c22](https://github.com/codefuturist/email-mcp/commit/3c44c226e7b3bf2666479e4d5761c8777d8c5e9c))

#### 📚 Documentation

- update tool count to 42 in README - ([4e6910c](https://github.com/codefuturist/email-mcp/commit/4e6910c04a8dd46efc739079c8e6aa613a7edfaf))
- add pnpm install and usage instructions - ([13c8d4b](https://github.com/codefuturist/email-mcp/commit/13c8d4bf3006fa4fb5f014eb630006a478082a23))

- - -
## [v0.1.2](https://github.com/bitfloo/mailoo/compare/3b384c6210890691b05dfd70de2754382ae8e96e..v0.1.2) - 2026-09-23
#### 🐛 Bug Fixes
- (**registry**) publish under io.github.Bitfloo, the namespace GitHub OIDC grants - ([13bd23a](https://github.com/bitfloo/mailoo/commit/13bd23aa43f351a8878ceb4ebc1ed83c5fbff74b)) - Mike, Claude Opus 5.5 (1M context)
- (**release**) push the v-prefixed tag cog actually creates - ([3b384c6](https://github.com/bitfloo/mailoo/commit/3b384c6210890691b05dfd70de2754382ae8e96e)) - Mike, Claude Opus 5.5 (1M context)
#### 📚 Documentation
- (**config**) MCP_EMAIL_SAVE_TO_SENT files into sent_mailbox when set - ([e7c6312](https://github.com/bitfloo/mailoo/commit/e7c631255a44f914144381a64e1b8013d7144253)) - Mike, Claude Opus 5.5 (1M context)
#### CI
- (**release**) publish to npm through trusted publishing, no token - ([a2020a8](https://github.com/bitfloo/mailoo/commit/a2020a859d8d33e3ebf317419f2ae2839eb6685c)) - Mike, Claude Opus 5.5 (1M context)

- - -

## [v0.1.1](https://github.com/bitfloo/mailoo/compare/4fdb1ad0b46c4a20dbc81ec40d62f64afba14c73..v0.1.1) - 2026-09-22
#### ✨ Features
- (**config**) let an account name the folder sent mail is filed in - ([bfac8ca](https://github.com/bitfloo/mailoo/commit/bfac8cae245f62e2a2607d3817464abdb8880b54)) - Mike, Claude Opus 5.5 (1M context)
- add Jev System One inbound classify - ([86d5811](https://github.com/bitfloo/mailoo/commit/86d58119fde31ee6ad8d4c4c0c5035316f6233d9)) - Mike, Cursor
- close upstream email-mcp gaps in the Mailoo fork - ([0daadad](https://github.com/bitfloo/mailoo/commit/0daadadae1d46266013f6dceb228e30a93a7dc85)) - Mike, Cursor
- add Mailoo-local test-auditor and test-smith - ([32518b5](https://github.com/bitfloo/mailoo/commit/32518b5e9da329c7af836b7902afea26e778eaa1)) - Mike, Cursor
#### 🐛 Bug Fixes
- keep MCP release jq safe when server.json has no packages - ([ac0f2ff](https://github.com/bitfloo/mailoo/commit/ac0f2ff29482ac51b368d1dfb58abb4ce417c381)) - Mike, Cursor
- bind Mailoo test docs to the runner configs - ([99f0279](https://github.com/bitfloo/mailoo/commit/99f02797203e059335604a2d99381d17ad9a6fee)) - Mike, Cursor
#### 📚 Documentation
- put GreenMail SQL/Docker WHY back and bind include-unit - ([6d02b09](https://github.com/bitfloo/mailoo/commit/6d02b093ba0ce4868cc0bbf3bdf140d151026a4f)) - Mike, Cursor
- add Cursor Cloud agent roster and pnpm install - ([7428f07](https://github.com/bitfloo/mailoo/commit/7428f071cb14d4537e1cee2501d0c2bdec39b976)) - Mike, Cursor
- stop advertising unpublished npm in MCP metadata - ([68812a8](https://github.com/bitfloo/mailoo/commit/68812a882bcdfb526c2b37f48b15c67f4ccb1721)) - Mike, Cursor
- honest install path until npm and add OSS face agents - ([307ce6c](https://github.com/bitfloo/mailoo/commit/307ce6c5a3a71e577771727146ff0764395d94f5)) - Mike, Cursor
- name GreenMail as a test IMAP/SMTP server, not a database - ([8949a91](https://github.com/bitfloo/mailoo/commit/8949a916ba0d82eb699e6248102512ef755e0dc4)) - Mike, Cursor
- keep Mailoo test agents project-local and run integration in CI - ([1d3b9a1](https://github.com/bitfloo/mailoo/commit/1d3b9a1340d0c5e53679e089c4830a05be44cdbf)) - Mike, Cursor
- point MCP clients at a local clone until npm exists - ([9c2c142](https://github.com/bitfloo/mailoo/commit/9c2c142c3bc95a84c4560fa91b8255cd5044c9ef)) - Mike
- document Sent APPEND, Sieve, and related MCP surface - ([d39e116](https://github.com/bitfloo/mailoo/commit/d39e116906dae0bfb4cb80be53566f02731d69b2)) - Mike, Cursor
- stop promising unpublished npm install - ([4fdb1ad](https://github.com/bitfloo/mailoo/commit/4fdb1ad0b46c4a20dbc81ec40d62f64afba14c73)) - Mike, Cursor
#### Tests
- pin IMAP dates, security tool, and attachment oracles - ([cc01195](https://github.com/bitfloo/mailoo/commit/cc01195fb3b7f55acab3d0fddbc2ca85738f718a)) - Mike, Cursor
- assert applyBodyFormat maxLength truncation boundaries - ([af69327](https://github.com/bitfloo/mailoo/commit/af69327451ba9eb27b75324d7332d8df20e49428)) - Mike, Cursor
#### CI
- keep the GreenMail PR incident note and skip a dead Docker socket - ([ba602e7](https://github.com/bitfloo/mailoo/commit/ba602e7121c5f397ac8735c61b18afd96e6ae720)) - Mike, Cursor
- run the full suite on the laptop, not on every GitHub push - ([e97f7d4](https://github.com/bitfloo/mailoo/commit/e97f7d484634cbc10e3f6de27e30af7a6b1acd62)) - Mike, Cursor
#### ♻️ Refactoring
- split mail-arrival setup and share the server.json bump - ([cbb912f](https://github.com/bitfloo/mailoo/commit/cbb912f42960bff01414b33d7dcfb36c2579b50a)) - Mike, Cursor
- shrink sieve client and forwardEmail under length limits - ([fb38c6a](https://github.com/bitfloo/mailoo/commit/fb38c6a05f6e1632fad9f9c9dbbdb7a4d487946a)) - Mike, Cursor
#### Chores
- (**agents**) raise Mailoo test ship bar to auditor score ≥ 9 - ([efb0a52](https://github.com/bitfloo/mailoo/commit/efb0a52dbb8328562123b474c16376abc10f127b)) - Mike, Cursor
- (**agents**) Cursor grok tier and strengthen test-auditor contract - ([2f49086](https://github.com/bitfloo/mailoo/commit/2f490866a22121304983a00ae6196104a32b5302)) - Mike, Cursor
- adopt patch-only 0.1.x versioning - ([977c1b8](https://github.com/bitfloo/mailoo/commit/977c1b87460b377bb357e82ba43c10da29a74fc6)) - Mike, Cursor
- gate public GitHub commit messages and document versioning - ([404d07f](https://github.com/bitfloo/mailoo/commit/404d07f2c23670cfa2ef5b8f67e079c6c1ce0ecb)) - Mike, Cursor
- keep CBC session scratch out of the public tree - ([589c149](https://github.com/bitfloo/mailoo/commit/589c1490fefc917da642090effe9911ccd193b1a)) - Mike, Cursor
- fix CODEOWNERS for GitHub org login - ([4aaa479](https://github.com/bitfloo/mailoo/commit/4aaa47917e651a1e47eb9cd6801b303d5df2cea9)) - Mike, Cursor
#### Styles
- split ManageSieve tlsConnect options onto their own lines - ([0a97613](https://github.com/bitfloo/mailoo/commit/0a976134397e01db154844a8805d7e258873da63)) - Mike, Cursor
- break ManageSieve TLS callback to satisfy biome check - ([9da9067](https://github.com/bitfloo/mailoo/commit/9da9067cf383624afb021432ea86f1b11301354a)) - Mike, Cursor
- wrap ManageSieve TLS connect callback for Biome - ([612b3ff](https://github.com/bitfloo/mailoo/commit/612b3ffa6268e4900fabc34f65b3f313acde3b41)) - Mike, Cursor

- - -

## [v0.2.1](https://github.com/codefuturist/email-mcp/compare/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0..v0.2.1) - 2026-02-20
#### 🐛 Bug Fixes
- (**labels**) fix critical parameter swap and multiple label bugs - ([bd6f94d](https://github.com/codefuturist/email-mcp/commit/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0)) - Colin
- defer post-connect work until MCP handshake completes - ([7847da0](https://github.com/codefuturist/email-mcp/commit/7847da07b4241e73282b2a36a9dd1a362dfb8656)) - Colin
#### Tests
- (**integration**) expand plain connection tests to match STARTTLS and SSL coverage - ([8bd3d77](https://github.com/codefuturist/email-mcp/commit/8bd3d7752ca18037ca899899a1e14688b961c0b1)) - Colin
- (**integration**) add connection mode tests for plain, STARTTLS, and implicit SSL - ([ccbefb7](https://github.com/codefuturist/email-mcp/commit/ccbefb78248f0f08d31c5b227347f286f350c9f9)) - Colin
- (**integration**) add integration test suite with GreenMail and Testcontainers - ([1cc72fe](https://github.com/codefuturist/email-mcp/commit/1cc72fec8166842fa92ad8c7957c2ec28df327ac)) - Colin
#### Build
- (**docker**) add OCI manifest annotations for GHCR multi-arch images - ([2aeb938](https://github.com/codefuturist/email-mcp/commit/2aeb93857e95d99b2cf4435e4eee7cd7a47aecdc)) - Colin
- (**docker**) add docker and goreleaser scripts, fix build for dockers_v2 context - ([56102f4](https://github.com/codefuturist/email-mcp/commit/56102f42ce81bba8c9ab8f442926d1b9704d2ab4)) - Colin
- (**docker**) add GoReleaser dockers_v2 for GHCR and Docker Hub publishing - ([83483a8](https://github.com/codefuturist/email-mcp/commit/83483a8879228b3ec213414f2f7c53e9cce3f497)) - Colin
- (**docker**) add Dockerfile, docker-compose, and CI docker build - ([e9f0a9f](https://github.com/codefuturist/email-mcp/commit/e9f0a9f2179a59de064879456204c8c3b4f3945b)) - Colin
- add lefthook git hooks, report output, upgrade actions and node to v24 - ([8665419](https://github.com/codefuturist/email-mcp/commit/86654197b1a1f252d6c67d8a5fd67f09100f4fd4)) - Colin
#### CI
- (**docker**) enable docker hub publishing - ([f2a8d44](https://github.com/codefuturist/email-mcp/commit/f2a8d44fb8e503a0ef053a716e00b5814625daf8)) - Colin
- refactor workflows to use codefuturist/shared-workflows@v1 - ([815292c](https://github.com/codefuturist/email-mcp/commit/815292c91e6215592cd3172a91600cf42b2224e0)) - Colin
- add docker-sha workflow, workflow_dispatch, action upgrades and lint fixes - ([ddfbcdc](https://github.com/codefuturist/email-mcp/commit/ddfbcdc27af83175c3fec3c666ebd1f23d0631f4)) - Colin
- improve Docker tag strategy - ([99785a0](https://github.com/codefuturist/email-mcp/commit/99785a0ea5c01579046783c3fdf7347932e77fdb)) - Colin
- add weekly Docker rebuild workflow for base image updates - ([08f77f9](https://github.com/codefuturist/email-mcp/commit/08f77f9d06c8fd5b6de65a08c9ff89b556e7f2c0)) - Colin
#### Chores
- (**eslint**) exclude integration tests from eslint - ([e3bcc12](https://github.com/codefuturist/email-mcp/commit/e3bcc122bb9d71bfdfd77040d4419b96296a162d)) - Colin
- (**gitignore**) update .gitignore to include comprehensive rules for various environments and tools - ([4c55dea](https://github.com/codefuturist/email-mcp/commit/4c55dea709e592f3e9f8b01d449846742774c07f)) - Colin
- fix changelog separator for cocogitto - ([55510c3](https://github.com/codefuturist/email-mcp/commit/55510c34bb44ac377e91e1c628d7a810ed2e6d6e)) - Colin

- - -


## [v0.1.0](https://github.com/codefuturist/email-mcp/releases/tag/v0.1.0) — Initial Release

First public release of email-mcp.

#### ✨ Features

- Full IMAP + SMTP email server for MCP clients
- 42 tools, 7 prompts, 6 resources
- Multi-account support with XDG-compliant TOML config
- Guided interactive setup wizard with provider auto-detection
- Gmail, Outlook, Yahoo, iCloud, Fastmail, ProtonMail, Zoho, GMX support
- OAuth2 XOAUTH2 for Gmail and Microsoft 365 _(experimental)_
- Email scheduling with OS-level scheduler integration
- Real-time IMAP IDLE watcher with AI-powered triage
- Urgency-based desktop / webhook alerts
- Provider-aware label management
- ICS/iCalendar extraction from emails
- Email analytics (volume, top senders, daily trends)
- Token-bucket rate limiter and audit trail
- MCP client auto-installer (Claude Desktop, VS Code, Cursor, Windsurf)
