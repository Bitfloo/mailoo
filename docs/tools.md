# MCP tools

The [README API tables](../README.md#api) are the index (names and
one-liners). This page documents parameters and behaviour for the Mailoo IMAP/SMTP tools. Config keys live in
[configuration.md](configuration.md).

Reporting security issues: [SECURITY.md](../SECURITY.md).

## `download_attachment`

Always registered (including `read_only`). Default response is base64,
capped at **5 MB**. When `read_only` is true, `savePath` is rejected and
no file is written.

`savePath` (optional) writes a new file under a **specific** working
directory and returns metadata only — no base64. Cap is **50 MB**.
A working directory of `/`, or a shared top-level directory such as
`/home`, `/Users`, `/tmp` and `/var` (and their real paths), is refused.
Hidden path segments, a file name that starts with `.`, and
application-data directories (`~/Library`
except iCloud Drive and CloudStorage, `~/AppData`, `~/snap`) are refused,
and Mailoo does not create directories for a refused path. Use base64,
or start the server in a dedicated folder. Absolute paths or `..` that
escape the working directory are rejected. `readOnlyHint` is **false**
on a writable server because this path writes disk, and **true** when
`read_only` is set. A directory `savePath` uses the attachment filename
(one path segment). An existing file is left unchanged.
A symlink is rejected.

Both caps compare the part size the server reports, not the file size.
Base64 carries 57 bytes in each 78-octet line, so that size runs about 37%
over the file, and the 5 MB cap holds a base64 file of about 3.65 MB. A
refusal of a base64 part names both sizes: the `~` estimate `get_email`
shows and the encoded one.

An attachment is chosen by `filename`. When two or more attachments in the
message carry that name, the call fails and the error lists their MIME
parts instead of returning the first one. The same refusal applies to
`send_email` attachments copied with `emailId` + `filename` and to
`send_draft` on a draft whose attachments share a name.

`add_to_calendar` with `save_attachments`, and the mail-arrival hook that
adds events to the calendar, save the non-calendar attachments of the
message under `$XDG_DATA_HOME/mailoo/calendar-attachments/`, up to 25 MB
each, as the server reports the part size (see the base64 note above).
A part that cannot be downloaded or written is skipped. Each file keeps only
the last path segment of the attachment name, without leading dots, and
attachments that share a name are saved as `name.ext`, `name-2.ext`, and so on.

## `export_email`

Returns one message as its raw RFC 822 source (`.eml`, `message/rfc822`):
the octets the server sends for `BODY.PEEK[]`, headers and every MIME part
included. `get_email` with `format="full"` returns the decoded body text,
not this source. Use `export_email` to archive a message that has no PDF,
such as a receipt sent only as the mail body.

Parameters: `account`, `id` (UID), `mailbox` (default `INBOX`), and
optional `savePath`. Size limits, `savePath` and `read_only` follow
`download_attachment`, with the same errors for a symlink, an existing
file, or a path outside the working directory. When `read_only` is true,
`savePath` is rejected and no file is written. A directory `savePath` names
the file `<YYYY-MM-DD>_<uid>.eml`
from the UTC date of the message's INTERNALDATE.

The mailbox is opened read-only (EXAMINE) and the source is fetched with
`BODY.PEEK[]`, so `\Seen` and every other flag stay as they were. A message
over the limit returns an error and nothing is written to disk. The size the
server reports (`RFC822.SIZE`) is checked before the source is fetched.

## HTML bodies (`get_email`, `get_emails`, `get_thread`)

An HTML part is converted (to text, or to sanitized HTML for `format="full"`)
from its first 2,097,152 characters only. A longer part ends with a note
that it was cut. Use `export_email` for the complete source.

## Calendar and Reminders (macOS)

`list_calendars`, `list_events` and `list_reminders` return an error when
`osascript` fails or times out (`list_events` 90 s, `list_reminders` 15 s,
`list_calendars` 10 s). An empty result means the app reported no items.

`add_to_calendar` returns `duplicate` when an event with the same ICS UID,
or the same title starting within 5 minutes, already exists in any
calendar. If that check fails or times out (90 s), the event is not added
and the status is `no_display` with the reason.

## `list_emails` / `search_emails` dates

Both accept ISO 8601 `since` and `before`.

`search_emails` also accepts `start_date` / `end_date` as aliases
(`since` / `before` win if both are set). `query` may be omitted for a
filter-only search.

## `list_emails` / `search_emails` previews

Each preview is read from the start of the message's text part
(`text/plain`, else `text/html`) and decoded from its transfer encoding
and charset. Text that starts several kilobytes into the part, such as an
HTML newsletter behind a long `<style>` block, gets no preview.

## `bulk_action`

Every id must be a single UID (a positive integer up to 4294967295), the
same rule as the single-message tools; any other id rejects the whole call
before the server is contacted. `mailbox` and `destination` follow the
mailbox-name rules of the other tools (no control characters or wildcards).

## `add_label` / `remove_label`

On servers that store labels as IMAP keywords, a keyword must be an IMAP
atom (RFC 9051): no spaces, control or non-ASCII characters, and none of
`( ) { % * " \ ]`. Both tools refuse any other label with an error before
anything is sent to the server, so a label such as `Receipts (2024)` fails
(an older release accepted it). A non-atom keyword that is already on a
message, set by another client or an older release, can no longer be
removed through Mailoo; clean it up in another mail client. Servers with a
label extension (for example Gmail labels) are not affected. On keyword
servers a system flag (a name that starts with `\`) is refused as before:
use `mark_email`.

## `delete_mailbox` / `rename_mailbox` / `delete_label`

`delete_mailbox` and `rename_mailbox` refuse INBOX (any letter case) and
every special-use folder: `\Trash`, `\Sent`, `\Drafts`, `\Junk`,
`\Archive`, `\All`, `\Flagged` and `\Important`, whether the server
announces the role (RFC 6154, and RFC 8457 for \Important) or, for most
roles, imapflow infers it from a well-known folder name. The server and
other mail clients file into these folders.
On Gmail a label is a folder, so `delete_label` applies the same refusal
(`INBOX`, `[Gmail]/Trash`, `[Gmail]/Sent Mail`, …).

## Calls on one account wait for each other

Tool calls share one IMAP connection per account (the mail watcher has its
own), and that connection runs one command at a time, so tool calls on the
same account queue. A call that opens a mailbox waits at most 60 seconds for
another call's mailbox lock, then fails with `Mailbox "<name>" stayed busy
for 60 s: an earlier operation on this account has not finished. Try again
later.` The earlier operation is not cancelled; retry the call once it has
finished.

## `get_email_security`

Read-only. Returns SPF/DKIM/DMARC from `Authentication-Results` (and
DKIM-Signature `d=` when Auth-Results has no DKIM), plus From /
Reply-To / Return-Path domains. Flags whether `List-Unsubscribe` /
`List-Unsubscribe-Post` headers exist; it does **not** return
unsubscribe or tracking URLs, and it does not change IMAP flags.

## ManageSieve

Requires a reachable ManageSieve endpoint ([configuration.md](configuration.md#managesieve)).
PLAIN auth needs TLS (implicit or STARTTLS).

Script uploads and each downloaded literal are limited to **1,048,576 bytes (1 MiB)**.
A complete server response is limited to **1,114,112 bytes (1 MiB + 64 KiB)** across
all lines and literals, including bytes already buffered. The extra 64 KiB allows
protocol framing, capability and status lines around a maximum-size script; the
same total limit bounds script lists and greetings. Invalid or oversized literal
lengths are refused before waiting for their payload.

Each server response and the TLS handshake has an absolute **30-second** deadline,
even while the peer keeps sending data. The initial TCP connect has an **8-second**
deadline. Exceeding a size or time limit closes the connection and reports an error;
`sieve_status` instead reports unavailability with a warning.

| Tool | Mode | RFC 5804 |
|------|------|----------|
| `sieve_status` | read | capability / availability |
| `sieve_list_scripts` | read | LISTSCRIPTS |
| `sieve_get_script` | read | GETSCRIPT |
| `sieve_put_script` | write | PUTSCRIPT (does not activate) |
| `sieve_delete_script` | write | DELETESCRIPT (deactivate first) |
| `sieve_activate_script` | write | SETACTIVE (empty name deactivates all) |

Write tools are omitted when `read_only` is true.

## Attachments on send and drafts

`send_email` `attachments[]`: each item needs **`path`**, **`base64`**,
or **`emailId` + `filename`** (copy from an existing message; `mailbox`
defaults to INBOX). Optional `contentType`. When two attachments of the
message share the copied `filename`, the item is refused, and so is
`send_draft` for such a draft; see [`download_attachment`](#download_attachment).

`path` must be a regular file under the process working directory or
the user's home directory. A path segment that starts with `.` is
refused, as are system locations (`/etc`, `/proc`, `/sys`, `/dev`, `/boot`),
`http:` / `https:` / `file:` / `data:` URLs, and a symlink whose target
leaves the allowed directories. A working directory of `/`, or a shared
top-level directory such as `/home`, `/Users`, `/tmp` and `/var` (and their
real paths), is refused. Application-data trees
under the home directory (`~/Library`, `~/AppData`, `~/snap`) are
refused, except `~/Library/Mobile Documents` (iCloud Drive) and
`~/Library/CloudStorage`.
Each attachment, and the attachments on one message together, must be
at most **50 MB**. The service reads the bytes itself.

`save_draft` accepts `path` or `base64` with the same rules. Drafts and
Sent APPENDs go through nodemailer MailComposer so **non-ASCII subjects
are RFC 2047 encoded**.

`send_draft` removes the draft after the mail is sent. If that removal
fails, the result still reports the mail as sent and says the draft is
still in Drafts; delete it there instead of sending it again.
