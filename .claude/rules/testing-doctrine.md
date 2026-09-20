# Mailoo testing doctrine

Rubric for the project `test-auditor` and `test-smith` agents. Cite by section.
Do not copy CBC plugin paths into this repo — they do not resolve here.

## Zero rule

A green suite is not quality. Quality is a defect the suite would have failed on.
Never report a test count, a coverage percentage, or a green badge as evidence.

Detection rate after hand-mutation: **<60%** weak, **60–80%** needs work, **>80%**
target. Never publish a rate without the survivor list.

Mailoo ship bar: `test-auditor` **PASS** requires **score ≥ 9** and zero CRITICAL
(INFO-only findings allowed). Scores 6–8 are improvement debt, not done.

## Two lanes

Read `package.json` before any runner command. The lanes are disjoint.

| Lane | Files | Command | Notes |
|---|---|---|---|
| Unit | `vitest.config.ts` `test.include` | `pnpm test -- <file>` | Colocated next to the module. Services stay testable without mocking MCP transports (`CLAUDE.md`). |
| Integration | `vitest.config.integration.ts` `test.include` | `pnpm test:integration -- <file>` | GreenMail: disposable **test IMAP/SMTP server** in Docker (not a database). Serial, one worker, longer timeouts. |

`mailoo test` / `src/cli/test.ts` is a **CLI connection probe**, not either runner.

Mailoo does not keep mail in SQL. Integration talks IMAP/SMTP to GreenMail so send, folders, flags and TLS hit a real protocol. Docker only hosts that Java process.

Pre-push (lefthook `pnpm test`) runs the unit lane only. IMAP/SMTP/watcher/scheduler/transport
changes also need the integration lane (`CLAUDE.md`).

No `retry:` in runner config. A flake is a defect. A raised timeout needs the
reason written at the constant.

## Layer from the shape of the object

| Shape | Layer | Oracle |
|---|---|---|
| Pure function, parser, schema, address/header helper | L1 | return value, named invariant |
| MCP tool/resource/prompt contract, CLI exit, HTTP session | L2 | schema + visible result / exit code |
| IMAP IDLE, watcher, scheduler, rate-limiter, connection pool | L3 | invariant after every step; no fire-and-forget |
| Agent or rule file in `.claude/agents/` or `.cursor/agents/` | L4 | the file text itself |
| A model-routing or prompt-behaviour claim | L5 | out of scope in this repo |

Testing an L3 object with L1 examples leaves interleavings untested. Name the
layer and the shape that forced it. Split a multi-layer object by layer.

## Fixtures and secrets

- Fixture shape 1:1 with production (real parsed mail, real tool args), not invented happy-path JSON.
- Prefer a real tmpdir and the real parser over a mock at an internal seam.
- `expect(mock).toHaveBeenCalled()` must not be a test's main assertion.
- No credentials, API keys, OAuth secrets, or example addresses with real domains (`CLAUDE.md`).
- Use reserved examples (`example.com`, `example.test`) and obvious fakes.
- Do not log passwords, tokens, or full message bodies at `info` or above.

## Agent rules

1. One behaviour per test; the `it` name is a claim (`should X when Y`).
2. Pin environmental input (clock, `$HOME`, network). Unpinned green is a CI bug.
3. Red is quoted runner output, then restored. "Should fail" is not evidence.
4. No test may pass with the tested behaviour gone.
5. Assert at the visible boundary, not inside a mock.
6. Comments carry WHY (incident or invariant), never WHAT.
7. Derive a roster from the tree when the claim is "every X"; a literal list drifts.
8. Never install a runner or mutation tool the manifest does not declare.
9. If a new test disagrees with the code, the code is wrong by default unless a named wrong assumption is stated.
10. Judgment that a suite meets the requirement is made by `test-auditor` in a fresh context, not by the author.

## Auditor checks (C1–C10)

| # | Check | Severity |
|---|---|---|
| C1 | Hand-mutants (boundary, logic, `return null`, dropped effect). Zero killed = CRITICAL; a survivor = WARN. |
| C2 | Suite still green after the behaviour is removed = CRITICAL. |
| C3 | Layer fits the object's shape. Clock/socket/IDLE tested only by examples → WARN. |
| C4 | Main oracle is `expect(mock).toHaveBeenCalled()` → WARN. |
| C5 | Fixture invented, not derived from a production artifact → WARN. |
| C6 | Several asserts in one `it`, or a name like `works correctly` → INFO (WARN if both). |
| C7 | Unpinned `$HOME`, real clock, real network → WARN. |
| C8 | `retry:` in runner config = CRITICAL. Bare timeout with no reason = WARN. |
| C9 | Shared mutable state; file-alone vs full-suite diverge = CRITICAL; shared state alone = WARN. |
| C10 | "X does not exist" without the search scope → INFO. |

CRITICAL means only: the suite's green is proven not to mean what it claims.

Not findings: semantically equivalent mutants; a mock at a genuine unpaid-external boundary; a slow suite that pays for real I/O on purpose; honest repetition; a layer the repo cannot run (browser E2E).

## What not to do

- Do not treat `pnpm test:coverage` as an audit.
- Do not add Playwright, Cypress, Selenium, or Puppeteer.
- Do not put doctrine tests where Vitest will not see them — add the path to `vitest.config.ts` `test.include`.
- Do not cite paths that do not exist in this clone.
