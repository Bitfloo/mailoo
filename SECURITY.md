# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x.x   | ✅ Latest  |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via [GitHub Security Advisories](https://github.com/bitfloo/mailoo/security/advisories/new).

You should receive a response within 48 hours. If the issue is confirmed, a fix will be released as soon as possible.

## Security Considerations

Mailoo handles email credentials and message content. What the current code actually does:

- **Credentials** — Passwords, OAuth client secrets, and refresh tokens are stored in the local TOML config written by `src/config/loader.ts` (writes land as mode `0600`) or read from `MCP_EMAIL_*` environment variables. Mailoo does not run a separate credential service. OAuth access tokens are cached in memory only (`src/services/oauth.service.ts`); a refresh does not write them back to the config file.
- **Audit logging** — Send, reply, forward, draft, folder, label, bulk, manage, sieve, template, and schedule tools append a JSON line through `src/safety/audit.ts`. Password, body, HTML, base64 content, and token or secret fields are redacted. Subjects and recipients are stored. Hook moves and flags (`src/services/hooks.service.ts`), local calendar and reminder writes, `savePath` file writes, and config saves are not audit entries. System One filing is audited (`src/services/mail-arrival/index.ts`). The default path is `$XDG_DATA_HOME/mailoo/audit.log`, which is `~/.local/share/mailoo/audit.log` when that variable is unset (`src/config/xdg.ts`).
- **Read-only mode** — `read_only: true` omits write tools (`src/tools/register.ts`). Hooks, the IMAP IDLE watcher, and the in-process scheduler do not start (`src/safety/write-side-effects.ts`). `get_email` ignores `markRead`. `download_attachment` rejects `savePath`. The registered tools are listed in [docs/configuration.md](docs/configuration.md#settingsread_only).
- **HTTP transport** — The default listen addresses are `127.0.0.1` and `::1` (`src/safety/http-transport.ts`). Setting `MCP_EMAIL_HTTP_TOKEN` does not change that bind. A non-loopback address is refused unless the token is set. `0.0.0.0` and `::` also require `MCP_EMAIL_HTTP_ALLOWED_HOSTS`. `Host` and `Origin` are checked against the names the process is serving, and request bodies are size-capped. See [docs/configuration.md](docs/configuration.md#http-transport).
- **TLS** — `tls` is implicit TLS. `starttls` requires STARTTLS, and the connection fails if the server does not offer it. When both are false the protocols differ: SMTP never attempts STARTTLS, while IMAP still upgrades if the server offers STARTTLS and then checks the certificate according to `verify_ssl`. That asymmetry is in `src/connections/manager.ts` (the `verify_ssl` default is on). ManageSieve `AUTHENTICATE PLAIN` requires TLS and always checks the certificate (`src/services/sieve.service.ts`).
- **Paths** — `savePath` and outgoing attachment paths are confined in `src/safety/local-paths.ts`, `src/tools/attachments.tool.ts`, and `src/services/outgoing-attachments.ts`. The working directory must be specific: `/` and the broad roots named in `src/safety/local-paths.ts` are refused. Hidden path segments, `~/Library` (except Mobile Documents and CloudStorage), `~/AppData`, and `~/snap` are refused. `savePath` does not overwrite an existing file. A symlink that leaves the allowed directory is refused. See [docs/tools.md](docs/tools.md).
- **Rate limiting** — Sends use a token bucket, 10 per minute unless configured otherwise (`src/safety/rate-limiter.ts`).
- **Input validation** — Tool inputs are checked with Zod schemas before the service call.

## Best Practices for Users

- Use app-specific passwords instead of your main account password
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/mailoo/audit.log`
- Use `read_only: true` in config if you only need read access
- Keep Mailoo updated to the latest version
