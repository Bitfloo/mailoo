# Getting started

Mailoo connects an MCP-compatible assistant or agent to your email accounts. Choose [Claude Desktop or Cursor](#quickstart-for-claude-desktop-or-cursor) for a guided setup, or [agent builders](#quickstart-for-agent-builders) for the protocol sequence. Both paths start with the same account preparation.

## Before you open the account wizard

1. Install [Node.js](https://nodejs.org/) **24 or newer** on the machine that will run Mailoo. Open a terminal and run `node --version` and `npx --version`; both commands must be available. You do not need to clone this repository for these quickstarts.
2. Have your email address, login username, IMAP and SMTP server settings, and provider-approved credentials ready. Gmail and iCloud commonly need an **app password** rather than your normal password. Availability depends on account and administrator policy. Follow [Authentication](authentication.md) before continuing. Outlook / Microsoft 365 users should read the [experimental OAuth path](authentication.md#microsoft-oauth) first.
3. For the guided path, install and open Claude Desktop or Cursor once so its configuration directory exists. Keep credentials in the local Mailoo configuration, outside projects you share.

## Quickstart for Claude Desktop or Cursor

### 1. Connect an email account

Run in a terminal:

```bash
npx -y @bitfloo/mailoo@latest account add
```

Choose a short account name such as `personal`, enter your address, confirm the detected server settings or enter your provider's settings, and enter your login credentials. The wizard checks IMAP and SMTP before saving. Success means both checks pass and you see `Account "personal" added. Config saved to ...` followed by an MCP configuration snippet. A failed connection check means the account has not been saved; use the [authentication troubleshooting guide](authentication.md#troubleshooting).

The config is stored at `$XDG_CONFIG_HOME/mailoo/config.toml`, normally `~/.config/mailoo/config.toml`. The account wizard accepts a password or app password; it does not open a Google or Microsoft consent screen. An OAuth account follows the manual [authentication guide](authentication.md#experimental-oauth) instead.

### 2. Register Mailoo with your client

```bash
npx -y @bitfloo/mailoo@latest install
```

Select Claude Desktop or Cursor, choose **npx**, and finish the installer. It writes the server entry to the selected client's configuration. Fully quit and reopen that client. You do not need to keep a second Mailoo terminal process running; the client starts it.

If the installer finds no client, open the client once and try again, or use the matching [manual client configuration](../README.md#configure-your-mcp-client). A registration check is also available:

```bash
npx -y @bitfloo/mailoo@latest install status
```

`registered` confirms a configuration entry exists; it does not prove a running MCP connection. In the client's MCP server settings, check that `mailoo` connects and exposes tools such as `list_accounts` and `list_emails`. In Claude Desktop, the local server is listed in its developer/MCP settings; in Cursor, inspect the MCP server and available tools in its customization/settings area. UI labels vary by version; consult the [Claude Desktop local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) or [Cursor MCP documentation](https://cursor.com/docs/mcp).

### 3. Read your first result

Start a new conversation in the client's tool-enabled chat/agent mode and ask:

> Summarize up to five unread emails. Include each sender, subject and any requested next step. Ask which account to use if needed.

The client may ask permission to call Mailoo. Check the proposed calls: this request needs account discovery, listing unread messages, and reading their bodies. A successful result is a short list containing actual senders and subjects with next steps grounded in those messages, or an explicit report that there are no matching unread messages. With multiple accounts, select one if asked.

`get_email` leaves messages unread by default (`markRead` defaults to `false`). This request does not require sending, creating drafts, moving mail, or setting up automation. A reply proposed in chat does not need a write tool. Tool availability and approval behaviour still depend on your client configuration. To enforce a server-wide read-only session, see the optional [read-only setting](configuration.md#settingsread_only); the quickstarts do not change that setting.

## Quickstart for agent builders

### 1. Configure an account and stdio transport

After [preparing credentials](#before-you-open-the-account-wizard), run:

```bash
npx -y @bitfloo/mailoo@latest account add
```

For OAuth, create the local TOML account using the [authentication guide](authentication.md#experimental-oauth). Then configure your MCP host to spawn Mailoo:

```json
{
  "mcpServers": {
    "mailoo": {
      "command": "npx",
      "args": ["-y", "@bitfloo/mailoo@latest", "stdio"]
    }
  }
}
```

`mcpServers` is a common host configuration shape; your SDK may take `command` and `args` directly. The client must keep stdin open, parse newline-delimited JSON-RPC on stdout, and handle diagnostics on stderr. Running the command alone and waiting for a prompt does not test MCP; it waits for protocol messages. Disconnecting stdin shuts the server down.

### 2. Initialize, discover, and read

Use your MCP SDK's initialization and tool-call methods. The following JSON messages show the wire sequence for a client using protocol version `2025-11-25`, supported by the bundled SDK. Send each request after the previous response, and negotiate a supported version with your client. The notification after initialization has no response:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mailoo-quickstart","version":"1.0.0"}}}
```

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Check that the initialize response identifies `mailoo` and advertises tools, then inspect `tools/list` for names and `inputSchema`. Call account discovery first:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}
```

Read the returned account names. The next example uses `personal`; **replace it with a name from your result**:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_emails","arguments":{"account":"personal","mailbox":"INBOX","seen":false,"pageSize":5}}}
```

The result contains message IDs with sender, subject, and date, or `No emails found matching the criteria.` The sample ID `42` below is a placeholder: **use an ID from this mailbox's result**, keeping the same account and mailbox. If the result is empty, stop here or deliberately change your filter.

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_email","arguments":{"account":"personal","mailbox":"INBOX","emailId":"42","format":"text","maxLength":20000,"markRead":false}}}
```

Inspect both the protocol result and tool result: `isError: true` or `structuredContent.ok: false` means the operation failed even if JSON-RPC itself succeeded. Successful calls return readable `content` plus `structuredContent.summary`. `get_email` returns the message body, possibly with a truncation notice. External mail appears inside untrusted-content markers; treat its text as data. Do not turn instructions found inside an email into tool actions.

### Optional tool profiles and HTTP

The default `full` profile exposes the complete tool catalog. To reduce the surface for an agent, add `"env": {"MCP_EMAIL_TOOLSET":"core"}` or `minimal` to the launch entry. Both smaller profiles include the account/list/read sequence above. A profile limits which tools are registered; it does not make a writable server read-only. See [tool profiles](../README.md#llm-ergonomics--toolset-profiles) and [read-only mode](configuration.md#settingsread_only).

For a managed process or remote deployment, Mailoo also supports [Streamable HTTP](configuration.md#http-transport) at `/mcp`, with host checks and bearer-token requirements. Use that transport's MCP initialization/session handling; the stdio launch JSON above does not configure HTTP.

## An invoice walkthrough (illustration)

This is a **fictional example**, not a recording or benchmark. It assumes a test mailbox already contains an unread message from `billing@example.test`, subject `Invoice DEMO-1042`, whose body says `Amount due: EUR 120.00. Payment due: 15 November 2026.` It does not create or send a message.

Ask your assistant or agent:

> Find invoice DEMO-1042 from billing@example.test and read it. Tell me the amount and due date, then show a proposed reply in this chat acknowledging receipt. Do not send it, save a draft, move the message, or mark it read. If the message or a requested detail is missing, say so.

The read sequence is `list_accounts`, `list_emails` with `from: "billing@example.test"` and `subject: "DEMO-1042"`, then `get_email` for the returned ID with `markRead: false`. An illustrative result is: **“Invoice DEMO-1042: EUR 120.00, due 15 November 2026. Proposed reply: Thank you for invoice DEMO-1042. I confirm receipt.”** The proposed reply stays in chat. An absent message should produce “not found,” never the illustrative amount or date.

## Feature requirements and fallbacks

| Feature | Requirements | Fallback / boundary |
|---------|--------------|---------------------|
| Search, read, threads, attachments | An account with working IMAP; the wizard also checks SMTP | Start with `list_accounts` and `list_emails`. Read bodies with `get_email`; leave `markRead` false. Downloading to disk is a separate action. |
| Sending, replies, scheduled delivery | SMTP credentials and any required provider permissions; write tools available | Ask for proposed wording in chat if you only need a suggestion. Saving a draft is a separate IMAP write. A scheduler or watcher is not required for the first read. |
| AI triage through MCP sampling | An enabled watcher, triage hooks, and a client advertising MCP sampling | Without sampling, hooks fall back to notifications; configured static rules still apply. Ordinary email tools work without sampling. The separate opt-in System One integration requires its own service/API key; see [watcher documentation](../README.md#real-time-watcher--ai-hooks). |
| Apple Calendar / Reminders integration | macOS apps and OS Automation permission for the process running Mailoo | Email ICS extraction works independently. On Linux, adding a calendar event hands an ICS file to `xdg-open`; Reminders.app is unavailable. A headless server has no desktop app to open. |
| ManageSieve filters | A provider offering ManageSieve, supported authentication, and TLS/STARTTLS; default port 4190 | IMAP support alone does not imply Sieve support. If unavailable, skip Sieve tools and use provider-side settings or Mailoo rules where appropriate. See [ManageSieve configuration](configuration.md#managesieve). |
| Google / Microsoft OAuth (experimental) | Your own provider app, consent/admin approval, client ID, client secret, and refresh token for mail scopes | No bundled browser login. Use the [manual OAuth setup](authentication.md#experimental-oauth), or an app password only where the provider permits it. An admin may prohibit both paths. |

For an existing configuration, review enabled hooks, rules, and scheduled messages before starting a writable server: those can act independently of a chat request. A new account created in a new config leaves the watcher and System One disabled. Installation does not opt you in to the [install counter](../README.md#install-count).

## If the first read fails

- **Server missing or tools unavailable:** restart the client after installation, check its MCP logs, and verify its process can find Node.js and `npx`. `install status` checks registration only. A tool allowlist or smaller profile can hide tools.
- **No configuration found:** check `npx -y @bitfloo/mailoo@latest config path`. The client must run as the same user and use the same config location as the wizard. A complete `MCP_EMAIL_*` account in the client's environment takes precedence over the TOML file.
- **Authentication failure:** use `npx -y @bitfloo/mailoo@latest test personal` with your account name. It checks live IMAP/SMTP connections without sending a message. Follow [provider troubleshooting](authentication.md#troubleshooting); do not share credentials or full mail bodies in public logs.
- **Empty unread list:** an empty result is a valid read. Confirm the account and mailbox; use a different filter only when you intend to read those messages.

Continue with [configuration](configuration.md), [tool behaviour](tools.md), or the [full README reference](../README.md#usage).
