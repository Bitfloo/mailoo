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

Mailoo handles sensitive email credentials and message content. The project includes several security measures:

- **No credential storage** — passwords and tokens are read from your local config file or environment variables at runtime
- **Audit logging** — all write operations are logged with automatic redaction of sensitive fields (passwords, email body content)
- **Rate limiting** — configurable rate limits on send operations (default: 10/minute)
- **Read-only mode** — `read_only: true` omits write tools and does not start hooks, the IDLE watcher, or the in-process scheduler. `get_email` ignores `markRead`. `download_attachment` rejects `savePath`. The registered tools are listed in [docs/configuration.md](docs/configuration.md#settingsread_only).
- **Input validation** — all tool inputs are validated with Zod schemas
- **ManageSieve** — AUTHENTICATE PLAIN requires TLS (implicit or STARTTLS)
- **HTTP transport** — listens on 127.0.0.1 and ::1 unless `MCP_EMAIL_HTTP_TOKEN` is set. `Host` and `Origin` must match the names the process is serving, and request bodies are size-capped. See [docs/configuration.md](docs/configuration.md#http-transport).

## Best Practices for Users

- Use app-specific passwords instead of your main account password
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/mailoo/audit.log`
- Use `read_only: true` in config if you only need read access
- Keep Mailoo updated to the latest version
