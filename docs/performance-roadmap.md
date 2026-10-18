# Performance Improvements Roadmap

> **Status**: Active  
> **Last Updated**: 2026-10-18

Performance for Mailoo operates across **three distinct layers**, each with different bottlenecks and optimization strategies. This roadmap tracks shipped optimizations and remaining improvements against the current implementation, ordered by impact.

## Key Insight

> The AI agent's **context window** — not IMAP speed — is the primary performance constraint.
> Returning 100 email bodies might be technically fast over IMAP, but it would **destroy** the LLM's context window budget.
> Therefore, **response shaping** (returning only what the AI needs, in the most compact form) is the #1 performance technique.

---

## Current State Assessment

### What's Already Well-Implemented ✅

| Technique | Status | Where |
|-----------|--------|-------|
| ENVELOPE fetching for listings | ✅ Done | `imap.service.ts` — uses `{ envelope: true }` |
| BODYSTRUCTURE for attachment detection | ✅ Done | `imap.service.ts` — uses `{ bodyStructure: true }` |
| Selective MIME part fetching | ✅ Done | `imap.service.ts` — `getEmail()`, `getEmails()`, `getThread()`, and `peekText()` walk `bodyStructure` (`findTextMimeParts`) and download leaf `text/plain` / `text/html` parts instead of full `source: true` (with a 64 KiB `source` fallback only when no text MIME parts exist) |
| Bounded UID date-sorting window | ✅ Done | `imap.service.ts` — `orderUidsByDate()` in `listEmails()` and `searchEmails()` fetches `ENVELOPE` only for the newest UID window (`Math.max(page * pageSize * 3, 250)`) for mailboxes with >250 matching messages |
| Source preview truncation & MIME stripping | ✅ Done | `imap.service.ts` — `maxLength: 4096` (`LIST_PREVIEW_SOURCE_MAX_BYTES`) with MIME boundary stripping and a 200-character preview cap |
| Body truncation & quote/signature stripping | ✅ Done | `email-body.ts`, `emails.tool.ts`, `thread.tool.ts` — default `format="text"` strips signatures and quoted replies (`strip_signature`, `strip_quoted`) and enforces a default 20,000-character cap (`applyBodyFormatWithDefaultCap`) plus `settings.body_max_chars` |
| Real-time IMAP IDLE watcher | ✅ Done | `watcher.service.ts` (`WatcherService`) — dedicated IDLE connections per monitored folder with exponential backoff reconnect (`1s` → `60s`) |
| Nodemailer SMTP connection pooling | ✅ Done | `manager.ts` — `pool: true` enabled by default (`max_connections = 1`, `max_messages = 100`) |
| Batch message & flag operations | ✅ Done | `imap.service.ts` — `getEmails()` (up to 20 UIDs) and `bulkSetFlags()` / `bulkMove()` / `bulkDelete()` using UID ranges (`ids.join(',')`) |
| Native IMAP MOVE (`messageMove`) | ✅ Done | `imap.service.ts` — uses ImapFlow `client.messageMove()` for single and bulk moves/Trash operations |
| Server-side IMAP SEARCH | ✅ Done | `imap.service.ts` — builds IMAP SEARCH criteria (subject, from, body, date, flags) |
| UID-based tracking | ✅ Done | All operations use `{ uid: true }` |
| Lazy connection creation | ✅ Done | `manager.ts` — connects on first use per account |
| Connection health checks | ✅ Done | `manager.ts` — checks `.usable` before reuse; SMTP `verify()` |
| Auto-reconnect with backoff | ✅ Done | `manager.ts`, `backoff.ts` — drops stale connections; after a failed connect waits 1 s doubling to 60 s, with jitter; `watcher.service.ts` reconnects its IDLE connections with exponential backoff |
| Thread cap | ✅ Done | Thread reconstruction capped at 50 messages |
| Contact extraction cap | ✅ Done | Caps at 500 recent messages for contact extraction |
| Rate limiting (sends) | ✅ Done | `rate-limiter.ts` — token-bucket, 10/min/account |
| Graceful shutdown | ✅ Done | `manager.ts` — `closeAll()` closes all connections |

### What's Missing ❌

| Gap | Current Behavior | Impact |
|-----|-----------------|--------|
| Conservative SMTP pool defaults | Pooling defaults to `max_connections=1`, `max_messages=100` | Low — tune for high-throughput workloads |
| No ENVELOPE/BODYSTRUCTURE cache | Fresh SEARCH + FETCH every request | High — repeat listings pay full IMAP cost |
| Unbounded initial UID list on `SEARCH` | `SEARCH` returns all matching UIDs before `orderUidsByDate()` bounds `ENVELOPE` fetches to the newest ≥250 UIDs | Medium — very large mailboxes still transfer the full UID list on search |
| No IMAP command pipelining control | Relies on ImapFlow auto-pipelining (good) but fetches extra data | Low — ImapFlow handles this well already |
| No connection keepalive (NOOP) on tool connections | On-demand IMAP connections in `ConnectionManager` may time out during long idle periods | Low-Medium — ImapFlow reconnects on next tool call |
| `has_attachment` filter is client-side | Post-filter after SEARCH (IMAP limitation) | Low — unavoidable IMAP protocol limitation |

---

## Improvement Roadmap

### Phase 1: High-Impact, Low-Effort

These improvements offer the best performance gains for minimal code changes.

#### P1.1 — Enable Nodemailer SMTP Connection Pooling ✅ Implemented

**Impact**: Medium | **Effort**: Trivial

```typescript
// connections/manager.ts — when creating transport
const transport = nodemailer.createTransport({
  host, port, secure,
  auth: { user, pass },
  pool: true,
  maxConnections: 1,
  maxMessages: 100,
});
```

**What it does**: Reuses SMTP connections across sends. Eliminates TLS handshake + AUTH per message. Nodemailer handles queuing, recycling, and connection health automatically.

**Current state**: Transport pooling is enabled by default (`pool.enabled = true`, `max_connections = 1`, `max_messages = 100`) and can be tuned per account via `config.toml` or `MCP_EMAIL_SMTP_POOL_*`.

#### P1.2 — Bounded UID Sorting & Server-Side Pagination (Partially Implemented)

**Impact**: High | **Effort**: Low

**Current behavior**: `listEmails()` and `searchEmails()` pass matching UIDs to `orderUidsByDate()`, which sorts UIDs ascending and fetches `ENVELOPE` headers only for a bounded window of the newest UIDs (`Math.max(page * pageSize * 3, 250)`) rather than fetching envelopes for every message in mailboxes with >250 messages. Older UIDs outside the window are appended in descending UID order before slicing `uids.slice(start, start + pageSize)`.

**Remaining target**: Avoid fetching the full UID array from `SEARCH` on huge mailboxes when no search filters are active by using `STATUS` (`messages`, `uidNext`) and UID-range constraints:
```typescript
// For "page 1, size 20" of an unfiltered mailbox with 10000 messages:
// 1. Use SEARCH / STATUS to get total count
// 2. Compute UID range for the desired window
// 3. FETCH only those UIDs
```

#### P1.3 — ENVELOPE/BODYSTRUCTURE In-Memory Cache

**Impact**: High | **Effort**: Medium

**Current behavior**: Every `listEmails()` call does a fresh SEARCH + FETCH, even for the same mailbox/page. Navigating back and forth repeats full IMAP round-trips.

**Target behavior**: Cache ENVELOPE and BODYSTRUCTURE per `account:mailbox:UID`, invalidated when `UIDVALIDITY` changes.

```typescript
interface CacheEntry {
  envelope: MessageEnvelope;
  bodyStructure: MessageStructure;
  flags: string[];
  cachedAt: number;
}

// Key: `${account}:${mailbox}:${uid}`
// Invalidate: when UIDVALIDITY changes or cache exceeds max entries
// Max entries: configurable, default 1000 per account
// TTL: none (UIDs are immutable per UIDVALIDITY)
// Flags: always re-fetch (flags change frequently)
```

**What it does**: Repeat listings and email metadata lookups are near-instant (<10ms vs 200-500ms). Thread reconstruction benefits most — currently does N FETCHes for N messages in thread.

---

### Phase 2: Response Shaping (Token Efficiency)

These improvements reduce AI context window consumption — the true bottleneck.

#### P2.1 — Selective MIME Part Fetching ✅ Implemented

**Impact**: High | **Effort**: Medium

**Current behavior**: Implemented in `src/services/imap.service.ts` (`messageToEmail` and `peekText`):
1. `getEmail()`, `getEmails()`, and `getThread()` fetch `{ uid: true, envelope: true, flags: true, bodyStructure: true, headers: ['references', 'content-type'] }` instead of `source: true`.
2. `findTextMimeParts(bodyStructure)` walks the MIME tree (skipping attachments and `message/rfc822` subtrees) to locate the leaf `text/plain` and `text/html` part numbers.
3. `downloadMimePart()` streams only those text parts via `client.download(uid, part, { uid: true })`.
4. Only when neither `text/plain` nor `text/html` is found in `bodyStructure` does `messageToEmail()` fall back to a bounded 64 KiB `source` fetch (`FALLBACK_SOURCE_MAX_BYTES = 65_536`).

**Savings**: Avoids downloading multi-megabyte attachments when reading email bodies.

#### P2.2 — Email Signature & Quoted Reply Stripping ✅ Implemented

**Impact**: Medium | **Effort**: Medium

**Current behavior**: Implemented in `src/utils/email-body.ts` (`stripSignature`, `stripQuotedText`, `applyBodyFormat`):
- `get_email`, `get_emails`, and `get_thread` default to `format = "text"`, `strip_quoted = true`, and `strip_signature = true`.
- Standard signature delimiters (`-- \n`) and quoted reply blocks (`On ... wrote:`, `-----Original Message-----`, `>` quote lines) are stripped before returning the body to the LLM.

#### P2.3 — Body Truncation with Overflow Indicator ✅ Implemented

**Impact**: Medium | **Effort**: Low

**Current behavior**: Implemented in `src/utils/email-body.ts` (`applyBodyFormatWithDefaultCap`, `DEFAULT_BODY_MAX_LENGTH = 20_000`):
- `get_email` and `get_thread` enforce a default 20,000-character limit when `maxLength` is omitted, appending `\n\n[Truncated at 20000 characters — pass a larger maxLength or format="full" if needed]` when truncated.
- Operators can also configure a hard ceiling via `settings.body_max_chars`.

#### P2.4 — Structured Thread Summaries (Partially Implemented)

**Impact**: High | **Effort**: Medium

**Current behavior**: `get_thread` applies `applyBodyFormatWithDefaultCap` (defaulting to `format="text"`, quote/signature stripping, and the 20,000-character per-message cap) and caps threads at 50 messages (`MAX_THREAD_MESSAGES = 50`).

**Remaining target**: Add a snippet-only summary mode on `get_thread` so 20-message threads can return compact 150-character snippets before expanding individual messages with `get_email`.

---

### Phase 3: Connection Management Hardening

These improvements increase reliability and reduce latency for sustained usage sessions.

#### P3.1 — Connection Pool with Checkout/Checkin

**Impact**: Medium | **Effort**: High

**Current behavior**: Single ImapFlow instance per account in `ConnectionManager` (plus dedicated IDLE connections in `WatcherService`). Concurrent tool calls on the same account serialize on the mailbox lock.

**Target behavior**: Pool of 1-3 ImapFlow instances per account:
```typescript
class ImapConnectionPool {
  private pool: Map<string, ImapFlow[]>;  // account → connections
  private maxPerAccount: number = 3;
  
  async checkout(account: string): Promise<PooledConnection>;
  release(connection: PooledConnection): void;
}
```

#### P3.2 — Robust Auto-Reconnect with Backoff ✅ Done

**Impact**: Medium | **Effort**: Low-Medium

**Current behavior**: After a failed IMAP connect or SMTP verify, the manager refuses a new attempt for that account until the window passes (1 s doubling to 60 s, up to 25 % jitter, no attempt limit), see [Reconnect backoff](configuration.md#reconnect-backoff).

**Original plan (superseded)**: Exponential backoff with jitter:
```typescript
// Reconnect strategy:
// Attempt 1: immediate
// Attempt 2: 1s + jitter
// Attempt 3: 2s + jitter
// Attempt 4: 4s + jitter
// Max attempts: 5
// Max delay: 30s
```

**Why**: Prevents thundering herd on temporary network issues. Avoids IMAP server ban from rapid reconnect attempts.

#### P3.3 — NOOP Keepalive for Idle Connections

**Impact**: Low-Medium | **Effort**: Low

**Current behavior**: `WatcherService` configures `maxIdleTime` (`idle_timeout = 1740` seconds by default) on IDLE connections. On-demand tool connections in `ConnectionManager` have no periodic NOOP timer and reconnect lazily if closed by the server.

**Target behavior**: Optional periodic NOOP every 5 minutes on active tool connections during interactive sessions.

---

### Phase 4: Advanced Optimizations

#### P4.1 — IMAP MOVE Command (RFC 6851) ✅ Implemented

**Current**: `moveEmail()`, `deleteEmail()`, `bulkMove()`, and `bulkDelete()` in `src/services/imap.service.ts` use ImapFlow's `client.messageMove()`, which uses native `MOVE` when supported by the server and falls back automatically.

#### P4.2 — CONDSTORE/QRESYNC Change Detection

**Current**: ImapFlow auto-negotiates these extensions, and `WatcherService` tracks `lastSeenUid` per folder. **Target**: Track `highestModSeq` per mailbox to re-fetch only messages with `MODSEQ > lastSeen`.

#### P4.3 — Contact Cache

**Current**: Extracts contacts from up to 500 recent messages on every call. **Target**: Cache extracted contacts per account with a 10-minute TTL.

#### P4.4 — IMAP IDLE for Real-Time Notifications ✅ Implemented

**Current**: Implemented in `WatcherService` (`src/services/watcher.service.ts`). Maintains dedicated IMAP IDLE connections per configured account and folder, tracks `lastSeenUid`, reconnects with exponential backoff, and emits `email:new` events consumed by `HooksService` (static rules, AI triage via MCP sampling, System One classification, and desktop/webhook alerts).

#### P4.5 — Selective BODYSTRUCTURE Fetch

**Current**: Fetches BODYSTRUCTURE on list operations alongside ENVELOPE to compute `hasAttachments` and extract text previews. **Target**: Make BODYSTRUCTURE fetching optional when attachment metadata is not needed.

---

## Performance Budget (Target Latencies)

| Operation | Current (est.) | Target | Target (cached) |
|-----------|---------------|--------|-----------------|
| `list_emails` (page of 20) | ~800ms | < 500ms | < 50ms |
| `get_email` | ~1.5s | < 1s | < 500ms (envelope cached) |
| `send_email` (no attachment) | ~3s | < 2s | N/A |
| `search_emails` | ~2s | < 2s | < 1s (UID cache) |
| `get_thread` (10 messages) | ~3s | < 1.5s | < 200ms (all cached) |
| `list_mailboxes` | ~500ms | < 500ms | < 50ms |
| `move_email` | ~500ms | < 500ms | N/A |

---

## Anti-Patterns to Avoid

| ❌ Anti-Pattern | Why It's Bad | ✅ Instead |
|----------------|--------------|------------|
| Fetch ALL UIDs then slice client-side | O(N) for large mailboxes; wastes memory | UID-range server-side pagination |
| Download full message source for body | Transfers attachments+HTML when only text needed | Selective MIME part fetch via BODYSTRUCTURE |
| Return entire thread as full bodies | Blows AI context window (40K+ tokens) | Structured snippets, load on demand |
| No SMTP connection pooling | TLS+AUTH overhead on every send | `pool: true` in Nodemailer |
| Fresh FETCH for every listing | 200-500ms per request for same data | In-memory ENVELOPE cache per UID |
| No connection timeout/backoff | Hangs on unresponsive server; thundering herd | Exponential backoff with jitter |
| Return quoted reply chains in body | 10x token waste on duplicate content | Strip quotes, flag `hasQuotedReply` |
| Cache email bodies in memory | Memory explosion on large mailboxes | Cache only ENVELOPE + BODYSTRUCTURE |

---

## Library Performance Features Reference

### ImapFlow — Already Handles For Us

| Feature | How | Notes |
|---------|-----|-------|
| ENVELOPE/BODYSTRUCTURE fetch | `fetch(range, { envelope: true, bodyStructure: true })` | Pre-parsed, compact |
| BODY.PEEK (no side effects) | Automatic with `bodyParts` | Never marks as Seen |
| Command pipelining | Automatic | Reduces round-trips |
| Server-side IMAP SEARCH | `client.search(criteria)` | Full RFC 3501 SEARCH |
| Async streaming | `for await (let msg of client.fetch(...))` | Low memory for large sets |
| CONDSTORE/QRESYNC | Auto-negotiated | Efficient change tracking |
| COMPRESS=DEFLATE | Auto-negotiated | Bandwidth reduction |
| Mailbox locking | `client.getMailboxLock()` | Concurrency safety |
| Gmail extensions | Auto-detected | Labels, Gmail SEARCH |

### Nodemailer — Already Handles For Us (once `pool: true` is set)

| Feature | How | Notes |
|---------|-----|-------|
| Connection pooling | `pool: true` | Reuses TCP/TLS connections |
| Connection recycling | `maxMessages: N` | Prevents stale connections |
| Concurrent sends | `maxConnections: N` | Queue + distribute |
| TLS/STARTTLS | `secure: true` | Automatic negotiation |
| OAuth2 _(experimental)_ | Built-in | Token refresh supported |
| Timeouts | `connectionTimeout`, `socketTimeout` | Prevents hanging |

### What We Build On Top

| Component | Purpose |
|-----------|---------|
| Connection pool manager | Multi-instance ImapFlow pool per account |
| ENVELOPE/BODYSTRUCTURE cache | In-memory, UID-keyed, UIDVALIDITY-invalidated |
| Response shaper | Truncation, signature strip, structured summaries |
| Smart MIME fetcher | Walk BODYSTRUCTURE tree, fetch text/plain only |
| Reconnect handler | Exponential backoff with jitter |
| Pagination engine | UID-range server-side pagination |
