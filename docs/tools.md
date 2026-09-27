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
A working directory of `/`, or a directory directly under `/` (or that
directory's real path), is refused. Hidden path segments, a file name
that starts with `.`, and application-data directories (`~/Library`
except iCloud Drive and CloudStorage, `~/AppData`, `~/snap`) are refused,
and Mailoo does not create directories for a refused path. Use base64,
or start the server in a dedicated folder. Absolute paths or `..` that
escape the working directory are rejected. `readOnlyHint` is **false**
on a writable server because this path writes disk, and **true** when
`read_only` is set because `savePath` is rejected. A directory `savePath`
uses the attachment filename (one path segment). An existing file is left
unchanged. A
symlink is rejected.

## `list_emails` / `search_emails` dates

Both accept ISO 8601 `since` and `before`.

`search_emails` also accepts `start_date` / `end_date` as aliases
(`since` / `before` win if both are set). `query` may be omitted for a
filter-only search.

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
leaves the allowed directories. A working directory directly under `/`,
or the real path of that directory, is refused. Application-data trees
under the home directory (`~/Library`, `~/AppData`, `~/snap`) are
refused, except `~/Library/Mobile Documents` (iCloud Drive) and
`~/Library/CloudStorage`.
Each attachment, and the attachments on one message together, must be
at most **50 MB**. The service reads the bytes itself.

`save_draft` accepts `path` or `base64` with the same rules. Drafts and
Sent APPENDs go through nodemailer MailComposer so **non-ASCII subjects
are RFC 2047 encoded**.
