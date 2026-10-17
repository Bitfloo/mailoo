# MCP tools

The [README API tables](../README.md#api) are the index (names and
one-liners). This page is the SSOT for parameters and behaviour that
landed with the Mailoo IMAP/SMTP dump. Config keys live in
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

An attachment is chosen by `filename`. When two or more attachments in the
message carry that name, the call fails and the error lists their MIME
parts instead of returning the first one. The same refusal applies to
`send_email` attachments copied with `emailId` + `filename` and to
`send_draft` on a draft whose attachments share a name.

`add_to_calendar` with `save_attachments`, and the mail-arrival hook that
adds events to the calendar, save every attachment of the message under
`$XDG_DATA_HOME/mailoo/calendar-attachments/`. Each file keeps only the last
path segment of the attachment name, without leading dots, and attachments
that share a name are saved as `name.ext`, `name-2.ext`, and so on.

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

## `list_emails` / `search_emails` dates

Both accept ISO 8601 `since` and `before`.

`search_emails` also accepts `start_date` / `end_date` as aliases
(`since` / `before` win if both are set). `query` may be omitted for a
filter-only search.

## `bulk_action`

Every id must be a single UID (a positive integer up to 4294967295), the
same rule as the single-message tools; any other id rejects the whole call
before the server is contacted. `mailbox` and `destination` follow the
mailbox-name rules of the other tools (no control characters or wildcards).

## `delete_mailbox` / `rename_mailbox` / `delete_label`

`delete_mailbox` and `rename_mailbox` refuse INBOX (any letter case) and
every special-use folder: `\Trash`, `\Sent`, `\Drafts`, `\Junk`,
`\Archive`, `\All`, `\Flagged` and `\Important`, whether the server
announces the role (RFC 6154, and RFC 8457 for \Important) or imapflow
infers it from a well-known folder name. The server and other mail
clients file into these folders.
On Gmail a label is a folder, so `delete_label` applies the same refusal
(`INBOX`, `[Gmail]/Trash`, `[Gmail]/Sent Mail`, …).

## Calls on one account wait for each other

Mailoo keeps one IMAP connection per account, and that connection runs one
command at a time, so tool calls on the same account queue. A call that
waits more than 60 seconds for its turn fails with `Mailbox "<name>" stayed
busy for 60 s: an earlier operation on this account has not finished.` The
earlier operation is not cancelled; retry the call once it has finished.

## `get_email_security`

Read-only. Returns SPF/DKIM/DMARC from `Authentication-Results` (and
DKIM-Signature `d=` when Auth-Results has no DKIM), plus From /
Reply-To / Return-Path domains. Flags whether `List-Unsubscribe` /
`List-Unsubscribe-Post` headers exist; it does **not** return
unsubscribe or tracking URLs, and it does not change IMAP flags.

## ManageSieve

Requires a reachable ManageSieve endpoint ([configuration.md](configuration.md#managesieve)).
PLAIN auth needs TLS (implicit or STARTTLS).

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
defaults to INBOX). Optional `contentType`.

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
