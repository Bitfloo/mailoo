# Configuration

Runtime TOML lives at `$XDG_CONFIG_HOME/mailoo/config.toml` (default
`~/.config/mailoo/config.toml`). The [README](../README.md#configuration)
covers install, the wizard, and the common `[settings]` / `[[accounts]]`
shape. This page is the SSOT for behaviour added around Sent copies,
IMAP4rev2, ManageSieve, read-only side effects, and stdio lifecycle.

Vulnerability reports: [SECURITY.md](../SECURITY.md). Do not open public
issues for credential leaks.

## `settings.save_to_sent`

Default **true**. After a successful SMTP send, Mailoo IMAP-APPENDs an
RFC 822 copy to the account’s `accounts.sent_mailbox` when set, otherwise
to the `\Sent` mailbox (or a folder named `Sent` if the special-use flag is
missing).

Set `sent_mailbox` when the server advertises no SPECIAL-USE: the client then
guesses by folder name, and on a mailbox that collected sent-shaped folders
from several clients the guess can land on an empty one. Measured on OVH MX
Plan: the guess picked `INBOX.INBOX.Sent` while live mail sat in
`INBOX.Sent Messages`.

It does **not** APPEND when:

- `save_to_sent = false`, or
- the SMTP host looks like Gmail (`gmail.com` / `googlemail.com`) or the
  account’s OAuth provider is `google` — Gmail already files Sent mail.

A failed APPEND does not fail the send. The SMTP result includes
`savedToSent: false` and a warning is logged.

Env: `MCP_EMAIL_SAVE_TO_SENT` (`false` to disable; default on).

```toml
[settings]
save_to_sent = true

[[accounts]]
name = "ovh"
sent_mailbox = "INBOX.Sent Messages"
```

## `settings.read_only`

Default **false**. When **true**:

- write MCP tools are not registered (send, drafts, labels, sieve writes, …)
- hooks, the IMAP IDLE watcher, and the in-process scheduler **do not start**

`download_attachment` stays registered. Passing `savePath` still writes
bytes under the process working directory — that is a disk write, not an
IMAP write. Details: [tools.md](tools.md#download_attachment).

Env: `MCP_EMAIL_READ_ONLY=true`.

## IMAP4rev2 (`disable_imap4rev2`)

Some hosts (notably Strato) advertise IMAP4rev2 while SEARCH/ESEARCH is
broken. Set this on the account IMAP block so ImapFlow sends IMAP4rev1
SEARCH instead.

Env: `MCP_EMAIL_IMAP_DISABLE_IMAP4REV2=true`.

```toml
[accounts.imap]
host = "imap.strato.de"
disable_imap4rev2 = true
```

## ManageSieve

Optional. Host defaults to the IMAP host; port defaults to **4190**.
AUTHENTICATE PLAIN is refused unless the socket is already TLS or the
server offers STARTTLS.

Env: `MCP_EMAIL_SIEVE_HOST`, `MCP_EMAIL_SIEVE_PORT`.

```toml
[accounts.imap]
sieve_host = "imap.example.com"
sieve_port = 4190
```

Tool list: [tools.md](tools.md#managesieve).

## Stdio shutdown

In `stdio` mode the process listens for stdin `end` / `close` (client
EOF) and then stops hooks, watcher, IMAP/SMTP, and the MCP server. It
does not attach a stdin `data` listener (that would steal protocol
bytes from the SDK).

## Extra environment variables

These supplement the table in the README (single-account env overlay).

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_EMAIL_READ_ONLY` | `false` | Skip write tools and mailbox writers |
| `MCP_EMAIL_SAVE_TO_SENT` | `true` | IMAP APPEND to `\Sent` after SMTP |
| `MCP_EMAIL_IMAP_DISABLE_IMAP4REV2` | `false` | Force IMAP4rev1 SEARCH |
| `MCP_EMAIL_SIEVE_HOST` | IMAP host | ManageSieve hostname |
| `MCP_EMAIL_SIEVE_PORT` | `4190` | ManageSieve port |
