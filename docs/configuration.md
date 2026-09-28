# Configuration

Runtime TOML lives at `$XDG_CONFIG_HOME/mailoo/config.toml` (default
`~/.config/mailoo/config.toml`). The [README](../README.md#configuration)
covers install, the wizard, and the common `[settings]` / `[[accounts]]`
shape. This page is the SSOT for behaviour added around Sent copies,
IMAP4rev2, ManageSieve, read-only side effects, stdio lifecycle,
and webhook targets.

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

Default **false**. When **true**, hooks, the IMAP IDLE watcher, and the
in-process scheduler **do not start**, and tools that write are not
registered.

The registered tools are exactly:

`analyze_email_for_scheduling`, `check_calendar_permissions`,
`check_health`, `check_notification_setup`, `download_attachment`,
`extract_calendar`, `extract_contacts`, `find_email_folder`, `get_email`,
`get_email_security`, `get_email_stats`, `get_email_status`, `get_emails`,
`get_hooks_config`, `get_thread`, `get_watcher_status`, `list_accounts`,
`list_calendars`, `list_emails`, `list_events`, `list_labels`,
`list_mailboxes`, `list_presets`, `list_reminders`, `list_scheduled`,
`list_templates`, `search_emails`, `sieve_get_script`, `sieve_list_scripts`,
`sieve_status`.

`get_email` ignores `markRead` and does not set `\Seen`.
Passing `savePath` returns an error and writes nothing; omit it to get the
attachment as base64. In this mode both tools are advertised as read-only.

Every other tool is omitted. That includes `add_to_calendar`,
`create_reminder`, `test_notification`, `configure_alerts`, and the send,
draft, label-change, mailbox, schedule-write, and sieve-write tools.

Env: `MCP_EMAIL_READ_ONLY=true`.

## `settings.hooks.alerts.allow_private_webhooks`

Default **false**. A webhook URL must use `http` or `https`. While this is
off, the host must not be a loopback, private, link-local, or other
non-global address, including a name that resolves to one. Set it to
**true** to allow a webhook on the local network, a VPN, or a tailnet.
The protocol check still applies.

Env: `MCP_EMAIL_ALERT_WEBHOOK_ALLOW_PRIVATE=true`.

```toml
[settings.hooks.alerts]
allow_private_webhooks = false
```

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

## HTTP transport

`mailoo http` listens on **127.0.0.1** and **::1**, port **8080**.

```bash
node dist/main.js http
node dist/main.js http 9090
```

To listen on one other address, set a bearer token in the environment. The token is not accepted as a command argument, because process arguments are visible to other users on the machine.

```bash
MCP_EMAIL_HTTP_TOKEN='replace-with-a-long-random-secret' \
  node dist/main.js http 8080 192.0.2.10
```

The command's host argument wins over `MCP_EMAIL_HTTP_HOST`. Clients send `Authorization: Bearer <token>` on every request, including `/health`.

`0.0.0.0` and `::` also require `MCP_EMAIL_HTTP_ALLOWED_HOSTS`: a comma-separated list of names that may appear in `Host`. An entry is a hostname (`mail.example`) or `host:port` (`mail.example:18080`). The port in an entry is not checked. A listed name is accepted on any port, including when `Host` omits the port. That is what a reverse proxy sends, and what a client sends when Docker publishes a different port than the process listens on. Names allowed only because the process is bound to loopback still have to use the listen port.

```bash
# Proxy on this machine. Mailoo stays on loopback; the public name is allowlisted.
MCP_EMAIL_HTTP_TOKEN='replace-with-a-long-random-secret' \
MCP_EMAIL_HTTP_ALLOWED_HOSTS='mail.example' \
  node dist/main.js http 8080
```

The loopback allowance cannot tell a proxy on the same machine from a local client (nginx forwards `Host` `127.0.0.1:<port>` by default), so every proxied deployment needs the token.

```bash
# The container listens on 8080. The published port is 18080.
MCP_EMAIL_HTTP_TOKEN='replace-with-a-long-random-secret' \
MCP_EMAIL_HTTP_ALLOWED_HOSTS='mail.example:18080' \
  node dist/main.js http 8080 0.0.0.0
```

Each request is checked before the body is handed to the MCP session:

- `Host` must be an allowed name, on the port rule above
- `Origin`, when present, must be `http:` or `https:` for an allowed host, with the same port rule as `Host` (a TLS-terminating proxy)
- `POST` must be `application/json` and at most **8 MiB**
- `X-Forwarded-Host` is ignored

Inside a container, loopback is the container's own loopback. Publishing the port means listening on `0.0.0.0` with a token and `MCP_EMAIL_HTTP_ALLOWED_HOSTS` set to the name clients use, with or without the published port.

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_EMAIL_HTTP_HOST` | `127.0.0.1` and `::1` | Single listen address. The host argument wins. |
| `MCP_EMAIL_HTTP_TOKEN` | unset | Bearer token. Required when the listen address is not loopback or `MCP_EMAIL_HTTP_ALLOWED_HOSTS` lists a non-loopback name. |
| `MCP_EMAIL_HTTP_ALLOWED_HOSTS` | listen address, or the loopback names | Required for `0.0.0.0` and `::`. Names or `host:port`. |

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
| `MCP_EMAIL_SAVE_TO_SENT` | `true` | IMAP APPEND after SMTP, to the account's `sent_mailbox` or else the `\Sent` special-use folder |
| `MCP_EMAIL_IMAP_DISABLE_IMAP4REV2` | `false` | Force IMAP4rev1 SEARCH |
| `MCP_EMAIL_SIEVE_HOST` | IMAP host | ManageSieve hostname |
| `MCP_EMAIL_SIEVE_PORT` | `4190` | ManageSieve port |
| `MCP_EMAIL_ALERT_WEBHOOK_ALLOW_PRIVATE` | `false` | Allow webhook targets on a LAN, VPN, or tailnet |
