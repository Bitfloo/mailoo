# Authentication

Prepare credentials before running `npx -y @bitfloo/mailoo@latest account add`. Mailoo connects to IMAP and SMTP; a working webmail login alone does not establish that those protocols are available.

| Account setup | Mailoo path |
|---------------|-------------|
| A provider that permits IMAP/SMTP passwords or app passwords | Use the account wizard below. |
| Gmail with app passwords available | Enable 2-Step Verification, generate an app password, then use the wizard. |
| iCloud Mail | Generate an Apple app-specific password, then use the wizard. |
| Google or Microsoft OAuth | Advanced, experimental manual setup using your own provider application and refresh token. The wizard does not perform browser authorization. |

Use [Node.js](https://nodejs.org/) **24 or newer**. Keep passwords, client secrets, authorization codes, and tokens out of shell history, chat, screenshots, public issues, and Git. Enter a password in the wizard's hidden prompt; edit OAuth values in the local config file with a trusted editor. The placeholder values on this page are not credentials.

## IMAP / SMTP passwords and app passwords

Obtain the IMAP host, SMTP host, ports, TLS mode, login username, and password type from your provider or administrator. Mailoo can detect settings for common address domains; custom domains may need manual settings. An administrator can disable IMAP, SMTP authentication, app passwords, or third-party applications independently.

```bash
npx -y @bitfloo/mailoo@latest account add
```

Give the account a local name, confirm or enter its servers, and enter the provider-approved password. The wizard probes both connections and saves only after both succeed. It does not send an email. For implicit TLS use `tls = true`; for a STARTTLS port use `tls = false` and `starttls = true`. Keep certificate verification enabled. Mailoo refuses unencrypted remote IMAP/SMTP connections; plain connections are accepted only on loopback for local services or test fixtures.

### Gmail app passwords

Turn on **2-Step Verification** in your Google Account, then open [Google's App Passwords page](https://myaccount.google.com/apppasswords). Create a password for Mailoo and enter that generated password in the wizard instead of your normal Google password. An app password may be unavailable for a managed account, Advanced Protection, or a 2-Step Verification setup limited to security keys. If it is missing, check with your administrator or use the OAuth path; do not weaken account protection to make it appear. Changing your Google Account password revokes app passwords. [Google's app-password guidance](https://support.google.com/accounts/answer/185833?hl=en)

Mailoo's detected Gmail settings are `imap.gmail.com:993` with implicit TLS and `smtp.gmail.com:465` with implicit TLS. Google also supports SMTP STARTTLS on port 587. [Google's IMAP/SMTP documentation](https://developers.google.com/workspace/gmail/imap/imap-smtp)

### iCloud app-specific passwords

With two-factor authentication enabled, sign in to [your Apple Account](https://account.apple.com/). Under **Sign-In and Security → App-Specific Passwords**, generate one for Mailoo. Use it in the wizard; do not enter your main Apple Account password. Revoking the app-specific password or resetting the main password requires new credentials in Mailoo. [Apple's instructions](https://support.apple.com/en-us/102654)

Use `imap.mail.me.com:993` with implicit TLS and `smtp.mail.me.com:587` with STARTTLS. Apple requires the full iCloud Mail address for SMTP login; use the full address as Mailoo's username, which is shared by its IMAP and SMTP connections. Check Apple's guidance for aliases or custom domains. [Apple's server settings](https://support.apple.com/en-us/102525)

## Experimental OAuth

Mailoo can refresh an access token from a configured `client_id`, `client_secret`, and `refresh_token`, then authenticate IMAP and SMTP with XOAUTH2. It does **not** ship a provider application, browser login, callback server, or one-click Outlook connection. The account wizard handles password credentials; the steps here are a separate manual setup for an application owner or administrator.

The existing implementation requires a client secret. Public-client, device-code, certificate-only, service-account, and app-only examples are not interchangeable with this configuration. Provider consent and protocol policies must permit the account. Mailoo's refresh requests are sent to the provider, with a 15-second timeout; access tokens are cached in memory. It does not persist replacement refresh tokens returned by a provider, so token rotation can require manually updating the local config and restarting the server.

### Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project. Configure the Google Auth Platform consent screen, audience, and data access. If the app is in testing, add the mailbox owner as a test user. Create an OAuth client of type **Web application**; save the issued **client ID** and **client secret** privately. Register the authorized redirect URI exactly as `https://developers.google.com/oauthplayground`. This is a manual setup using Google's tool, not a Mailoo callback. [Google's web-server flow and credential setup](https://developers.google.com/identity/protocols/oauth2/web-server)
2. Open the official [OAuth 2.0 Playground](https://developers.google.com/oauthplayground). In its configuration panel, choose the server-side flow and Google endpoints, enable **Use your own OAuth credentials**, and enter the client ID and secret from step 1. Set **Access type: Offline** and **Force prompt: Consent Screen**. Your credentials pass through Google's proxy server. Without your own credentials, Playground refresh tokens are automatically revoked after 24 hours.
3. In Playground Step 1, enter `https://mail.google.com/` and authorize the mailbox owner. This is the mail scope used by Mailoo for IMAP/SMTP; a narrower Gmail API scope is not a substitute. It grants broad mailbox access and is subject to Google's restricted-scope requirements and Workspace controls. [Gmail XOAUTH2 scopes](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)
4. In Playground Step 2, select **Exchange authorization code for tokens**. Copy the returned **refresh token** into the local TOML block below, together with the same app's client ID and secret. Do not use the short-lived access token as `refresh_token`. Do not share a Playground link containing credentials or tokens. [Playground exchange and credential options](https://developers.google.com/oauthplayground)

If consent is refused, review the app audience/test-user list, verification requirements, and organization policy rather than bypassing the warning. External apps left in Google's **Testing** publishing status normally receive refresh tokens that expire after seven days for this scope. Revocation, account changes, or token limits can also invalidate them. [Google's token-expiration rules](https://developers.google.com/identity/protocols/oauth2)

### Microsoft OAuth

This path needs an administrator or developer who can register and operate a **confidential Web application**. Follow Microsoft's [IMAP/SMTP OAuth guide](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) and [authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow). Do not send a Microsoft client secret through Google Playground or an unrelated online token generator.

#### Register the application

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **App registrations → New registration**. Choose the supported account types permitted by your organization; include personal Microsoft accounts only if needed. Record **Application (client) ID** and **Directory (tenant) ID** from the overview. [Registration instructions](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
2. Under **Authentication**, add a **Web** redirect URI handled by your own application or administrator's authorization tool. For local development this might be `http://localhost:3000/auth/redirect`, but only if your app actually listens there. For a hosted callback, use an HTTPS URI you control. The value must match in registration, authorization, and code exchange. Mailoo does not listen at this address. [Redirect URI setup](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)
3. Under **Certificates & secrets → Client secrets**, create a secret and privately save its **Value**, not its secret ID. Note its expiry. Mailoo currently supports secret-based refresh, so a tenant requiring certificate or federated credentials cannot use this path unchanged. [Credential instructions](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)
4. Configure **delegated** Exchange Online permissions `IMAP.AccessAsUser.All` and `SMTP.Send` (Office 365 Exchange Online in the API permissions picker), and obtain consent as required by the tenant. Authorization must request the full Outlook resource scopes below plus `offline_access`. Microsoft Graph `Mail.Read`, `Mail.ReadWrite`, or `Mail.Send` tokens target a different resource and do not authenticate IMAP/SMTP. This is a user-delegated authorization-code flow, not a client-credentials grant. [Required mail scopes](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)

#### Authorize and exchange the code

Use Microsoft's [documented authorization-code REST flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#request-an-authorization-code) in your confidential app or an administrator-approved **local** HTTP/OAuth tool. That tool must handle the registered callback and retain secrets locally. This is an advanced manual procedure; it is not a command in Mailoo.

Choose the authority consistently. For a tenant-specific app, replace `TENANT_ID` below with the directory ID. `common` is appropriate only for an app registration/account type that permits it. Mailoo's built-in `microsoft` provider uses `common`; a single-tenant setup should use the custom-provider TOML shown below.

Authorization is a browser GET to `https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/authorize` with these query parameters, URL-encoded by the app/tool:

| Field | Value |
|-------|-------|
| `client_id` | Application (client) ID |
| `response_type` | `code` |
| `redirect_uri` | The exact registered Web callback URI |
| `response_mode` | `query` |
| `scope` | `https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access` |
| `state` | A fresh random value generated and verified by your app/tool |
| `code_challenge`, `code_challenge_method` | Your app/tool's PKCE challenge and `S256`, when using PKCE |

Sign in as the mailbox owner and grant the requested permissions. The callback receives `code` and `state`; validate `state` before using the code. An administrator may need to grant consent first. Keep the returned URL/code private and exchange it promptly, once.

In the same private app/tool, make the [code-exchange request described by Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#redeem-a-code-for-an-access-token): **POST** to `https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/token`, content type **`application/x-www-form-urlencoded`**, with these form fields. Use local secret fields rather than a shell command or a synced/shared request collection:

| Field | Value |
|-------|-------|
| `grant_type` | `authorization_code` |
| `client_id` | The same client ID |
| `client_secret` | The secret **Value** saved during registration |
| `code` | The callback's authorization code |
| `redirect_uri` | The exact URI used in authorization |
| `scope` | The same Outlook scopes and `offline_access` |
| `code_verifier` | The original verifier if the authorization request used PKCE |

Read **`refresh_token` from the successful token endpoint JSON response**, then put it in TOML with the same app's client ID and secret. If absent, check that `offline_access` was requested and consented. MSAL's usual `AuthenticationResult` does not expose a refresh token for copying; obtaining only an MSAL access-token result does not complete this manual configuration. Microsoft's [refresh-token guidance](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens) explains replacement and expiration. Mailoo does not save rotated refresh tokens; repeat the approved authorization procedure and update TOML when necessary.

For Microsoft 365, also have the administrator confirm IMAP and **SMTP AUTH** are allowed for the mailbox. OAuth consent does not override protocol or Conditional Access policies. Ask for a permitted configuration instead of disabling organization-wide protections. [SMTP AUTH controls](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission)

### Save the local OAuth account

Use `npx -y @bitfloo/mailoo@latest config path` to locate the file. For a new file, `npx -y @bitfloo/mailoo@latest config init` creates a password template; replace its example account with your OAuth account rather than leaving an unused example entry. For an existing file, add a separate `[[accounts]]` block with a unique name. Never commit this file. Keep its directory private (`0700`) and the file private (`0600`) on systems with POSIX permissions; use equivalent user-only access on Windows.

This complete Google account uses placeholder credentials:

```toml
[[accounts]]
name = "personal"
email = "you@example.com"

[accounts.oauth2]
provider = "google"
client_id = "replace-with-your-client-id"
client_secret = "replace-with-your-client-secret"
refresh_token = "replace-with-your-refresh-token"

[accounts.imap]
host = "imap.gmail.com"
port = 993
tls = true
verify_ssl = true

[accounts.smtp]
host = "smtp.gmail.com"
port = 465
tls = true
starttls = false
verify_ssl = true
```

For Microsoft's built-in `common` authority, use `provider = "microsoft"` with credentials issued through that authority. Change the servers to `outlook.office365.com:993` (implicit TLS) and `smtp.office365.com:587` (`tls = false`, `starttls = true`). Confirm the SMTP endpoint for your account type with your provider; these are Mailoo's detected Outlook settings.

For a **single-tenant** Microsoft app, use the same IMAP/SMTP settings and replace the OAuth block with this one. Replace `TENANT_ID` in **both** URLs with your directory ID and use the token obtained from that tenant:

```toml
[accounts.oauth2]
provider = "custom"
client_id = "replace-with-your-client-id"
client_secret = "replace-with-your-client-secret"
refresh_token = "replace-with-your-refresh-token"
auth_url = "https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/authorize"
token_url = "https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/token"
scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send", "offline_access"]
```

Keep `custom` accounts entirely in TOML; the single-account environment overlay does not supply custom endpoints. Custom authorization/token URLs require HTTPS, except that HTTP is accepted for loopback hosts (`localhost`, a full `127.0.0.0/8` address, or `::1`). Never point a token URL at an untrusted endpoint: it receives the client secret and refresh token.

### Probe the account and restart

```bash
npx -y @bitfloo/mailoo@latest test personal
```

Replace `personal` with your account name. This **live-account connection probe** refreshes the token and checks IMAP and SMTP without sending a message. Look for both `IMAP ✓` and `SMTP ✓` and `All accounts OK`. A failure exits with an error. Restart the MCP client/server after editing credentials, then continue with the [first read](getting-started.md).

## Troubleshooting

| Symptom | Check / next step |
|---------|-------------------|
| Password rejected | Confirm the username and provider-approved password type. Gmail/iCloud usually need app passwords, not the webmail password. Recreate revoked app passwords and update Mailoo. |
| App password option missing | Check 2FA, account eligibility, and administrator policy. Use an approved OAuth setup or contact the administrator. |
| `redirect_uri_mismatch` / `AADSTS50011` | Make registration, authorization request, and code-exchange URI identical; check scheme, path, and port. Mailoo is not the callback handler. |
| Consent denied / `admin_policy_enforced` / approval required | Check test-user/audience settings and ask the administrator to approve the app and mail permissions where permitted. |
| `invalid_client` | Check the client ID, secret **value**, secret expiry, app type, and authority. A secret ID is not the credential. |
| `invalid_grant` / expired or revoked refresh token | Reauthorize the same application with offline access and replace the refresh token locally. Check Google's testing expiry and Microsoft token rotation/policies. Restart Mailoo. |
| OAuth succeeds but IMAP/SMTP rejects login | Check that the token targets the mail resource, the mailbox matches the consenting user, and both protocols are enabled. A Graph token is insufficient. |
| IMAP passes, SMTP fails | Check SMTP host, port, STARTTLS, and mailbox SMTP AUTH policy. Do not disable certificate checks or organization-wide protections to bypass a refusal. |
| Old credentials are still used | Restart the MCP process and check for a complete `MCP_EMAIL_*` account in its environment: it overrides the TOML account. |

Share only the error category and sanitized settings when asking for help. Review logs yourself before attaching them. For credential leaks, follow [SECURITY.md](../SECURITY.md) rather than opening a public issue.
