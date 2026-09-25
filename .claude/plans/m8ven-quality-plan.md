# m8ven quality plan

Audit date: 2026-09-25 · Baseline: `ea905dc` (v0.1.5) · Status: plan only, nothing implemented.

Goal: resolve the findings behind the m8ven.ai listing for Mailoo
(`https://m8ven.ai/mcp/bitfloo/mailoo`, section "Quality suggestions") and
the issues found in the code while auditing it.

Status tags: **[F]** verified in code, command output or API · **[W]**
inference · **[D]** guess.

## 0. Open blocker

The listing text was not readable during the audit (network policy of the
audit environment). The exact suggestions and score are **unknown**. Before
starting work, copy the "Quality suggestions" section into table 3.0 and map
every suggestion to an ID below, or add a new ID with evidence.

## 1. How m8ven scores (from search-result summaries, pages not fetched) [W]

- Pillars: code, verification depth, reputation. "New projects cap at C
  until adoption is earned."
- Methods: static analysis, CVE scanning, capability mismatch detection,
  publisher verification; "40+ code and supply-chain checks".
- Recurring suggestion on other listings: declare all four tool hints
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) as
  explicit booleans that match the handler's behaviour.
- Claiming the listing gives a verified-publisher badge and the full
  findings; connecting GitHub re-scans on every push.

Mailoo at baseline [F]: repo created 2026-09-20, 0 stars; npm 0.1.5 with
SLSA provenance; MCP Registry entry active but without `packages`;
`pnpm check`, `pnpm typecheck`, `pnpm test` (326/326) green;
`pnpm audit --prod` 64 advisories (16 high). Expect the letter grade to stay
at C until adoption grows [W]; fixes raise the points and clear findings.

## 2. Findings

Effort: S ≤ 0.5 day · M 0.5–2 days · L > 2 days or time-bound.

### Security (S1–S16)

Details, reproduction steps and exact code locations are **kept out of the
public tree** until fixes ship (SECURITY.md: report privately). Maintainers
hold them in a private advisory/notes. Fix-commit messages stay neutral
(`.claude/rules/public-git.md`).

| ID | Prio | Effort | Area |
|---|---|---|---|
| S8 | P0 | M | HTTP transport hardening |
| S1 | P0 | M | outgoing attachments |
| S2 | P0 | S | single-message IMAP tools input validation |
| S3 | P1 | S | `download_attachment` file writes |
| S4 | P1 | S | `configure_alerts` |
| S5 | P1 | S | webhook URL validation |
| S9 | P1 | S | HTML body processing |
| S10 | P1 | S | config file handling |
| S11 | P1 | S | IMAP TLS options |
| S6 | P2 | S | scheduler input validation |
| S7 | P2 | S | un-awaited audit promises in `apply_template` |
| S12 | P2 | M | HTTP session isolation |
| S13 | P2 | S | ManageSieve input validation |
| S14 | P2 | S | CLI scheduler install |
| S15 | P2 | M | marking untrusted mail content for the model |
| S16 | P2 | S | Docker base image pinning, HEALTHCHECK |

### Tool metadata (A1–A8)

| ID | Prio | Effort | Finding | Evidence |
|---|---|---|---|---|
| A1 | P0 | M | 0/56 tools declare all four hints (missing: `idempotentHint` 51, `openWorldHint` 52, `destructiveHint` 2). Most likely listing item [W] | `tools/list` probe over `registerAllTools` [F] |
| A2 | P0 | S | 11 tools declare hints that contradict the handler: `get_email` `readOnlyHint:true` but `markRead` writes; `destructiveHint:false` on overwriting tools `download_attachment`, `configure_alerts`, `sieve_put_script`, `remove_label` (Proton strategy); policy: `send_email`, `reply_email`, `forward_email`, `apply_template`; judgment: `schedule_email`, `sieve_activate_script` | `emails.tool.ts:159,193-195`, `attachments.tool.ts:78`, `watcher.tool.ts:285`, `sieve.tool.ts:116`, `label.tool.ts:112` [F] |
| A3 | P1 | M | `read_only` still registers 6 tools that can write: `get_email` (markRead), `download_attachment` (savePath), `configure_alerts` (save), `add_to_calendar`, `create_reminder`, `test_notification`; contradicts `docs/configuration.md:47-49` | `register.ts:61-77` [F] |
| A4 | P1 | M | `server.tool` / `server.resource` / `server.prompt` are `@deprecated` in SDK 1.26; no tool has `title` or `outputSchema` | SDK `server/mcp.d.ts:80-175` [F] |
| A5 | P1 | S | Descriptions reference things that do not exist or mislead: `list_emails_metadata` (`calendar.tool.ts:516,595`), `skipDuplicateCheck` (`:258`); `forward_email` drops original attachments; "delete" in `bulk_action`/`cancel_scheduled` moves to Trash | [F] |
| A6 | P2 | M | Schemas unbounded: no `maxLength`, no `maxItems` on recipients/attachments, IDs may be ≤0, dates are free strings | probe [F] |
| A7 | P2 | S | Inconsistent errors: several tools without try/catch; `get_emails` never returns `isError`; `test_notification` reports failure as text | [F] |
| A8 | P1 | S | No test enforces hints or the read_only contract; `register.test.ts` only asserts mocks were called (doctrine C4) | `register.test.ts:113-159` [F] |

Proposed hints (readOnly / destructive / idempotent / openWorld), assuming
decisions 5.1 and 5.2 below [W]:

```
list_accounts T F T F | list_mailboxes T F T T | list_emails T F T T | get_email F F T T* | get_emails T F T T
get_email_status T F T T | search_emails T F T T | download_attachment F T T T* | extract_contacts T F T T
get_thread T F T T | list_templates T F T F | extract_calendar T F T T | add_to_calendar F F F T
check_calendar_permissions T F T F | list_calendars T F T F | list_events T F T F | list_reminders T F T F
create_reminder F F F T | analyze_email_for_scheduling T F T T | get_email_stats T F T T | check_health T F T T
find_email_folder T F T T | get_watcher_status T F T F | list_presets T F T F | get_hooks_config T F T F
check_notification_setup T F T F | test_notification F F F F | configure_alerts F T T T | get_email_security T F T T
sieve_status T F T T | sieve_list_scripts T F T T | sieve_get_script T F T T | send_email F T F T | reply_email F T F T
forward_email F T F T | move_email F F T T | delete_email F T T T | mark_email F F T T | list_labels T F T T
add_label F F T T | remove_label F T T T | create_label F F T T | delete_label F T T T | bulk_action F T T T
save_draft F F F T | send_draft F T F T | create_mailbox F F T T | rename_mailbox F F T T | delete_mailbox F T T T
apply_template F T F T | schedule_email F T F T | list_scheduled T F T F | cancel_scheduled F T T T
sieve_put_script F T T T | sieve_delete_script F T T T | sieve_activate_script F T T T
* 1.0.0: drop get_email.markRead and split savePath into a write tool, then readOnly = T
```

### Capabilities (C1–C2)

| ID | Prio | Effort | Finding | Evidence |
|---|---|---|---|---|
| C1 | P1 | S | `resources.subscribe: true` is declared but no `resources/subscribe` handler exists; `resources/updated` is sent without subscriptions | `server.ts:27`, `hooks.service.ts:417-418` [F] |
| C2 | P1 | S | Description says "IMAP/SMTP MCP server" but the server also calls HTTP endpoints (OAuth, webhook, opt-in System One), spawns processes (`osascript`, `notify-send`, `xdg-open`, crontab/launchd) and writes files; no single capabilities/data-flow section | `oauth.service.ts`, `notifier.service.ts`, `mail-arrival/index.ts`, `local-calendar.service.ts`, `reminders.service.ts`, `cli/scheduler.ts` [F] |

### Dependencies (D1–D4)

| ID | Prio | Effort | Finding | Evidence |
|---|---|---|---|---|
| D1 | P0 | S–M | Production advisories: `nodemailer@8.0.1` (fix ≥9.1.1; latest 10.0.10), `smol-toml@1.6.0` (fix ≥1.7.1), and transitive via `@modelcontextprotocol/sdk@1.26.0` (`hono`, `@hono/node-server`, `fast-uri`, `express-rate-limit`, `path-to-regexp`, `ip-address`, `qs`, `body-parser`) | `pnpm audit --prod` [F] |
| D2 | P2 | S | Dev advisories (157 total incl. 2 critical `protobufjs` via `testcontainers`) | `pnpm audit` [F] |
| D3 | P2 | S | `@typesafe-ai/sdk` (created 2026-09-12) is imported statically although System One is off by default | `mail-arrival/index.ts:5-6`, `schema.ts:131` [F] |
| D4 | P1 | S | Dependabot is configured but has never opened a PR | `.github/dependabot.yml`; 0 PRs [F] |

### Distribution and docs (M1–M6)

| ID | Prio | Effort | Finding | Evidence |
|---|---|---|---|---|
| M1 | P1 | S | `server.json` has no `packages[]` although npm is published; registry entry is not installable | registry API [F]; removed in `68812a8` [F] |
| M2 | P1 | S | README and `smithery.yaml` say the package is not on npm and `npx` fails; `npx -y @bitfloo/mailoo --help` works | `README.md:83,98,128,156,162,353,362,368`; `smithery.yaml:3` [F] |
| M3 | P2 | S | `smithery.yaml` has empty `configSchema` and needs a local build | [F] |
| M4 | P2 | S | GitHub description differs from `package.json`; no homepage; no GitHub Releases for v0.1.2–v0.1.4 | GitHub API [F] |
| M5 | P1 | S | SECURITY.md claims do not match code ("No credential storage", "all write operations are logged", read_only) | `SECURITY.md:21-24` [F] |
| M6 | P2 | S | Real-domain example addresses | `README.md:341,409`; `smtp.service.test.ts:259-260` [F] |

### Pipeline (P1–P4)

| ID | Prio | Effort | Finding | Evidence |
|---|---|---|---|---|
| P1 | P1 | S | Actions pinned to tags, not SHAs | `.github/workflows/*.yml` [F] |
| P2 | P1 | S | `npm install -g npm@latest` and `mcp-publisher` from `releases/latest` without checksum in `id-token: write` jobs | `release.yml:40,55-63` [F] |
| P3 | P2 | S | CI does not run on push to `develop`; badge shows an old commit | `ci.yml:6-9` [F] (policy decision) |
| P4 | P2 | S | No CodeQL / OpenSSF Scorecard; every change is a direct push | [F] |

### Listing and reputation (L1–L4)

| ID | Prio | Effort | Finding |
|---|---|---|---|
| L1 | P0 | S | Listing text unknown (section 0) |
| L2 | P0 | S | Listing not claimed (no verified publisher, no full findings) [W] |
| L3 | P1 | S | No continuous verification (connect GitHub) [W] |
| L4 | P2 | L | Grade capped at C for new projects [W] |

## 3. Fix plan (what · how · verify)

### 3.0 Listing mapping

| Listing suggestion (quote) | ID | Decision |
|---|---|---|
| *(fill in from the listing)* | | |
| expected: "all four hints … match the handler's behaviour" | A1, A2, A8 | fix |
| expected: CVEs | D1, D2 | fix |
| expected: capability mismatch | C1, C2, A3 | fix |

### 3.1 Tool metadata
- **A4** — migrate to `registerTool` / `registerResource` / `registerPrompt`, add `title`; names, input schemas and URIs unchanged. Verify: no `server.tool(`/`server.resource(`/`server.prompt(` left; `tools/list` snapshot identical except `title`/annotations.
- **A8** — unit test (add to `vitest.config.ts` `test.include`): real `McpServer` + stub services + `registerAllTools`, read `tools/list` through `InMemoryTransport` + `Client`; assert 4 boolean hints per tool, equality with the table above, `readOnly:true` ⇒ every tool `readOnlyHint:true`, counts 56/7/6. Red first, quoted; then `test-auditor` in a fresh session (≥9, no CRITICAL).
- **A1 + A2** — set hints from the table. Verify: A8 green.
- **A3** — move `add_to_calendar`, `create_reminder`, `test_notification`, `configure_alerts` to write groups; in read_only reject `savePath` and ignore `markRead` in the service layer (no schema change). Update `docs/configuration.md`. Verify: A8.
- **A5** — fix descriptions. Verify: test that backticked names in descriptions exist as tools/params.
- **A6** — bounds (`maxLength`, `maxItems`, positive ints, ISO dates). Schema change → collect for 1.0.0. Verify: probe test.
- **A7** — shared error wrapper returning `isError`. Verify: per-tool tests.

### 3.2 Capabilities
- **C1** — implement `resources/subscribe`/`unsubscribe` with per-session URI sets and notify only subscribed URIs, or drop `subscribe: true`. Verify: `Client.subscribeResource` test, or capability absent.
- **C2** — README "Capabilities & data flows" table (network hosts, processes, file paths, env vars); broaden `description` in `package.json`/`server.json`. Verify: every `child_process`, `fetch(`, `fs.write*` in `src/` has a row.

### 3.3 Dependencies
- **D1** — `nodemailer` ^10 (9.0.0 enforces TLS on URL/OAuth fetches, 10.0.0 needs Node ≥20 [F]), `smol-toml` ^1.9, SDK ^1.30.1 plus refreshed transitive versions (SDK still allows old `hono`) or `pnpm.overrides`. Verify: `pnpm audit --prod` 0 high/critical; `pnpm ci:local` incl. GreenMail.
- **D2** — refresh dev lockfile. Verify: no critical.
- **D3** — dynamic import when `system_one.enabled`; `optionalDependencies`. Verify: module not loaded when disabled.
- **D4** — check Dependabot version + security updates in repo/org settings. Verify: a Dependabot PR appears.

### 3.4 Distribution and docs
- **M1** — restore the `packages` block removed in `68812a8` (`npm`, `@bitfloo/mailoo`, `commandArguments: ["stdio"]`, stdio) plus `environmentVariables` (`MCP_EMAIL_*`, password `isSecret`). Verify: schema validation; registry API shows `packages` after release.
- **M2** — `npx -y @bitfloo/mailoo` as main install path; drop "not on npmjs"; recheck the GHCR sentence. Verify: grep for those phrases = 0; run every README snippet.
- **M3** — smithery: `npx` command and `configSchema` mapped to `MCP_EMAIL_*`.
- **M4** — align GitHub description/homepage; release notes.
- **M5** — rewrite SECURITY.md after the security fixes; every claim backed by a test or `file:line`.
- **M6** — `example.com` / `example.test`, or a WHY comment.

### 3.5 Pipeline
- **P1** — pin `uses:` to SHAs with version comments. Verify: `grep -nE "uses: [^@]+@v[0-9]"` = 0; `actionlint`.
- **P2** — fixed npm version (≥11.5.1); fixed `mcp-publisher` tag + `sha256sum -c`.
- **P3** — (decision) unit job on push to `develop`.
- **P4** — `codeql.yml`, `scorecard.yml`, explicit `permissions:`.

### 3.6 Security
Per ID: fix, unit test proving the bad input is rejected (red first),
GreenMail integration test for IMAP/SMTP/transport changes. Details in the
private notes.

### 3.7 Listing
- **L1** — fill 3.0. **L2** — claim the listing as Bitfloo; store full findings. **L3** — connect GitHub after the fix release. **L4** — adoption; track the reputation breakdown weekly.

## 4. Order

```
Wave 0  L1, L2, D4 (no code)
Wave 1  S8 → D1 → S1, S2 → S3, S5, S9, S10, S11 → S4, S6, S7, S13 → S12, S14–S16
Wave 2  A4 → A8 (red) → A1+A2 → A3 → A5 ; C1
Wave 3  M1 → M2 → M3 ; C2 ; M5 (after A3, S4, S10) ; M4, M6
Wave 4  P2 → P1 ; P3 (decision) ; P4
Wave 5  release (patch) → L3 → re-scan on m8ven → compare with 3.0
1.0.0   schema changes: A6, strict ID formats, removing markRead / splitting savePath
```

Every IMAP/SMTP/watcher/scheduler/transport change runs
`pnpm test:integration`. Before push: `pnpm ci:local`, `oss-push-gate`.

## 5. Decisions needed

1. Sending mail → `destructiveHint: true`? (recommended: yes)
2. `openWorldHint: true` for every tool touching a remote IMAP/SMTP/Sieve/HTTP server? (recommended: yes)
3. Security fixes without schema change as patch releases; schema changes in 1.0.0? (recommended: yes)
4. HTTP mode: loopback-only by default; token mandatory for non-loopback?
5. CI unit job on push (changes current CLAUDE.md policy)?
6. Connect GitHub to m8ven (third-party app access)?
