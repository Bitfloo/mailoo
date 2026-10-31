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

Mailoo handles email credentials and message content. What the code does:

- **Credentials** — Passwords, OAuth client secrets, and refresh tokens are stored in the local TOML config written by `src/config/loader.ts` (writes land as mode `0600`) or read from `MCP_EMAIL_*` environment variables. Mailoo does not run a separate credential service. OAuth access tokens are cached in memory only (`src/services/oauth.service.ts`); a refresh does not write them back to the config file.
- **Audit logging** — Send, reply, forward, draft, folder, label, bulk, manage, sieve, template, schedule, and `configure_alerts` tools append a JSON line through `src/safety/audit.ts`, and so do `download_attachment` and `export_email` when they write a `savePath`, and `add_to_calendar` and `create_reminder`. Password, body, HTML, base64 content, and token or secret fields are redacted. Subjects and recipients are stored. A `configure_alerts` entry keeps only the origin of a webhook URL, and a `savePath` entry stores the requested and the written path. A calendar or reminder entry stores the dialog status: a cancelled dialog or a duplicate event is `ok`, a timeout or a missing display is `error`. Hook moves, flags and automatic calendar adds (`src/services/hooks.service.ts`), config saves from the CLI, and `get_email` with `markRead=true` (it sets `\Seen`; `src/tools/emails.tool.ts`) are not audit entries. System One filing is audited (`src/services/mail-arrival/index.ts`). The default path is `$XDG_DATA_HOME/mailoo/audit.log`, which is `~/.local/share/mailoo/audit.log` when that variable is unset (`src/config/xdg.ts`). The log is mode `0600` in a `0700` directory; looser existing modes are tightened on the first write. A `mailoo` data directory that is a symlink is left alone: the directory it points to keeps its mode, and only the log file is made `0600`. A failed write prints one stderr line and does not turn a finished tool call into an error.
- **Read-only mode** — `read_only = true` omits write tools (`src/tools/register.ts`). Hooks, the IMAP IDLE watcher, and the in-process scheduler do not start (`src/safety/write-side-effects.ts`). `get_email` ignores `markRead`. `download_attachment` and `export_email` reject `savePath`. The registered tools are listed in [docs/configuration.md](docs/configuration.md#settingsread_only).
- **HTTP transport** — The default listen addresses are `127.0.0.1` and `::1` (`src/safety/http-transport.ts`). Setting `MCP_EMAIL_HTTP_TOKEN` does not change that bind. A non-loopback address or a non-loopback name in `MCP_EMAIL_HTTP_ALLOWED_HOSTS` is refused unless the token is set. `0.0.0.0` and `::` also require `MCP_EMAIL_HTTP_ALLOWED_HOSTS`. `Host` and `Origin` are checked against the names the process is serving, and request bodies are size-capped. See [docs/configuration.md](docs/configuration.md#http-transport).
- **TLS** — `tls` is implicit TLS. `starttls` requires STARTTLS, and the connection fails if the server does not offer it. When both are false the protocols differ: SMTP never attempts STARTTLS, while IMAP still upgrades if the server offers STARTTLS and then checks the certificate according to `verify_ssl`. That asymmetry is in `src/connections/manager.ts` (the `verify_ssl` default is on). ManageSieve `AUTHENTICATE PLAIN` requires TLS and always checks the certificate (`src/services/sieve.service.ts`).
- **Paths** — `savePath` and outgoing attachment paths are confined in `src/safety/local-paths.ts`, `src/tools/attachments.tool.ts`, and `src/services/outgoing-attachments.ts`. The working directory must be specific: `/` and the broad roots named in `src/safety/local-paths.ts` are refused. Hidden path segments, `~/Library` (except Mobile Documents and CloudStorage), `~/AppData`, and `~/snap` are refused. `savePath` does not overwrite an existing file. A symlink that leaves the allowed directory is refused. See [docs/tools.md](docs/tools.md).
- **Data sent to a third party** — System One classification is off by default. When `settings.watcher.enabled` and `settings.system_one.enabled` are both on and `TYPESAFE_API_KEY` is set, each classified message is sent to `api.typesafe.ai` (or `TYPESAFE_BASE_URL`): sender name and address, subject, links, attachment names and MIME types, SPF/DKIM/DMARC results and domains, the account and folder name, and your folder descriptions. With `include_body = true` the body text is sent too, up to `body_max_chars`. The full list is in [README.md](README.md#system-one-opt-in-typed-filing) (`src/services/mail-arrival/state.ts`).
- **Rate limiting** — Sends use a token bucket, 10 per minute unless configured otherwise (`src/safety/rate-limiter.ts`).
- **Input validation** — Tool inputs are checked with Zod schemas before the service call.

## Dependency checks

`pnpm audit --prod` checks the server dependencies; `pnpm audit` includes development tooling too. The full audit currently reports [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) for retained `minimatch` copies. The legacy parsers used by lint and archive tooling do not implement the affected `optimizationLevel >= 2` preprocessing. Lint also retains minimatch 10 because `eslint-plugin-import-x` needs the `makeRe` API removed in version 11; its reviewed callers use the default optimization level, and this repository does not enable level 2. The archive walker uses patched glob and minimatch releases. `tests/dependency-floors.test.ts` bounds the retained versions and lint consumers and refuses a lint configuration that enables the vulnerable preprocessing. The advisory is not suppressed in pnpm configuration.

## Best Practices for Users

- Use app-specific passwords instead of your main account password
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/mailoo/audit.log`
- Use `read_only = true` in config if you only need read access
- Keep Mailoo updated to the latest version
