# Changelog

All notable changes to **Mailoo** are documented here.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

<!-- next-header -->

## [0.1.7] — 2026-09-29

### Behaviour changes

- A scheduled message can be sent again if the process dies after the SMTP
  server has accepted it but before the queue records it as sent. Another
  check may send it after the claim goes stale. That is at least once, not
  exactly once.

## [0.1.6] — 2026-09-28

### Behaviour changes

- IMAP accounts with `starttls = true` now refuse a server that does not
  offer STARTTLS instead of continuing without TLS. Use `tls = true` on the
  implicit-TLS port, or fix the server.

- `MCP_EMAIL_HTTP_ALLOWED_HOSTS` with a non-loopback name now requires
  `MCP_EMAIL_HTTP_TOKEN`. Set a token and send it as `Authorization: Bearer`.

- Label tools refuse IMAP system flags (use `mark_email`) and, on Gmail,
  system labels other than `\Inbox`, `\Starred` and `\Important` (use
  `move_email` or `delete_email`).

- HTTP mode: new-mail hooks use the most recent connected client that
  supports sampling; when none is connected, mail that no rule matched
  goes to notifications.

- Text from incoming mail in tool results is marked as external content, except
  attachment names and bytes.

- Scheduler install no longer overwrites an unreadable crontab.

- `get_emails` (when no requested message could be fetched) and
  `test_notification` (on a failed notification) now return an MCP error
  result (`isError`) instead of ordinary text.

- The server does not advertise `resources.subscribe` and does not send
  `notifications/resources/updated`. `resources.listChanged` remains.

- `read_only` does not register tools that write. `add_to_calendar`,
  `create_reminder`, `test_notification`, and `configure_alerts` are
  omitted, along with send, draft, label-change, mailbox, schedule-write,
  and sieve-write tools. `list_labels` and `list_scheduled` are now
  available in read_only. `get_email` and `download_attachment` stay
  registered: `markRead` does not set `\Seen`, and `savePath` is rejected.

- Webhook host names that resolve to a non-global address are refused
  (previously only IP literals were). Redirects are not followed. A failed
  or timed-out lookup refuses the webhook. The POST uses the address that
  was checked, so a name whose answer changes before connect is still
  refused. Shared address space (`100.64.0.0/10`, including tailnet
  addresses), benchmarking, reserved, site-local, local-use NAT64
  (`64:ff9b:1::/48`), discard-only (`100::/64`),
  dummy prefix (`100:0:0:1::/64`), SRv6 (`5f00::/16`), and
  IPv4 embedded in a compatible, NAT64, or 6to4 address are refused too.
  Webhooks to a LAN, VPN, or tailnet service need `allow_private_webhooks = true`.

- A single-message id must be one UID greater than 0. Ranges and lists such as
  `1:*` and `1,2`, and leading zeros such as `01`, are rejected. Previously
  `1:*` addressed every message in the mailbox.

- Desktop notifications pass message text to the OS notifier as data, not as script source.

- `send_at` must be an ISO 8601 date-time with a UTC offset, for example
  `2026-10-01T09:00:00+02:00`. Seconds may be omitted (`2026-10-01T09:00Z`
  and `2026-10-01T09:00+02:00`). A time with no offset is rejected, because
  the server's local zone is ambiguous. `send_at` with an impossible calendar
  date is refused.

- Scheduled mail is limited to 366 days ahead, 100 pending schedules
  (a message still being sent counts; a failed one does not), 50 recipients,
  998 characters for the subject and for In-Reply-To and References, and a
  body of 5 million characters.

- `configure_alerts` refuses a webhook URL that includes credentials
  (`user:password@`). The config file still accepts one, because that file
  is operator-controlled.

- Sieve script names are checked before they are sent, and a script is
  limited to 1 MiB.

- Config files Mailoo writes are mode 0600 (an existing file's mode is replaced);
  a directory Mailoo creates is 0700. Loading never changes a mode; a file
  readable by group or other logs a warning.

- Outgoing attachment `path` values are read by Mailoo instead of being passed
  to Nodemailer, which accepted any local path and fetched `http:`, `https:`,
  and `data:` URLs itself. Refused:
  - paths outside the working directory or home directory, including when the
    working directory is `/tmp`, a symlink to it, or that directory's resolved
    path (such as `/private/tmp`)
  - path segments whose names start with `.`
  - system locations (`/etc`, `/proc`, `/sys`, `/dev`, `/boot`)
  - every URL
  - application-data folders: `~/Library` except iCloud Drive
    (`Mobile Documents`) and `CloudStorage`, plus `~/AppData` and `~/snap`
  - one attachment, or all attachments on a message together, over 50 MB

  Download a remote file first and attach the local copy.

- `download_attachment` `savePath` leaves an existing file unchanged and
  refuses a symlink, and keeps the file name to one path segment. It refuses
  a hidden directory, a file name that starts with `.`, and application-data
  directories (`~/Library` except iCloud Drive (`Mobile Documents`) and
  `CloudStorage`, plus `~/AppData` and `~/snap`). A working directory of `/`
  or another broad root is refused, and Mailoo does not create directories
  on that path. Use base64 mode, or start the server in a dedicated folder.
  A failure to check or create the path is reported by its code, without the
  server's path.

- Nodemailer 10 checks TLS certificates on remote URL fetches and OAuth token
  requests. A fetch to an untrusted certificate is refused. SMTP itself is
  unchanged: `verifySsl` still controls the mail connection, and Mailoo still
  passes a ready access token rather than asking Nodemailer to refresh one.

- `mailoo http` listens on loopback by default (previously `0.0.0.0`). A
  non-loopback bind requires `MCP_EMAIL_HTTP_TOKEN`, and `0.0.0.0` / `::` also
  requires `MCP_EMAIL_HTTP_ALLOWED_HOSTS`. To keep the previous bind, set the
  host to `0.0.0.0` or `::` and set both of those variables.

- A hostname listed in `MCP_EMAIL_HTTP_ALLOWED_HOSTS` is accepted in `Host` on
  any port (the entry may be a name or `host:port`). `Origin` may be `https:`
  as well as `http:`. Names allowed only because the process is on loopback
  still have to use the listen port.

### Added

- Sent IMAP APPEND after SMTP (`save_to_sent`; skipped for Gmail)
- IMAP4rev2 opt-out for broken SEARCH (e.g. Strato)
- ManageSieve tools (TLS required for PLAIN)
- `get_email_security`, attachment `savePath`, search `since`/`before`

### Changed

- `read_only` also skips hooks, watcher, and the in-process scheduler
- Stdio shutdown on client stdin EOF; RFC 2047 encoded draft/Sent subjects

See [docs/configuration.md](docs/configuration.md) and
[docs/tools.md](docs/tools.md).

## [0.1.1] — 2026-09-21

- Adopt patch-only **0.1.x** versioning (`cog bump --auto` advances patch, including `feat`)

## [0.1.0] — 2026-09-20

First Mailoo release. Public LGPL-3.0-or-later fork of
[email-mcp](https://github.com/codefuturist/email-mcp) by codefuturist,
rebranded and maintained by Bitfloo. This is not an official codefuturist
project. Original copyright remains with the original authors.

- Rebrand as Mailoo (`@bitfloo/mailoo`, `mailoo` CLI, XDG dirs under `mailoo`)
- Add `COPYING` (GNU GPL-3) and `NOTICE` as required by LGPL-3
- Replace `codefuturist/shared-workflows` with in-repo GitHub Actions
- Start Mailoo versioning at 0.1.0 (do not treat upstream tags as Mailoo releases)

---

## Upstream history (email-mcp)

The following entries document the upstream project before the fork.
They are **not** Mailoo releases. Commit links point at
[codefuturist/email-mcp](https://github.com/codefuturist/email-mcp).

## Upstream unreleased ([3886bac..4e6910c](https://github.com/codefuturist/email-mcp/compare/3886bac..4e6910c))

#### ✨ Features

- **(alerts)** add notification setup diagnostics and AI-configurable alerts - ([34e288a](https://github.com/codefuturist/email-mcp/commit/34e288acb3a3330fd4eca0a583540ec877d9912c))
- **(alerts)** add urgency-based multi-channel notification system - ([b2425df](https://github.com/codefuturist/email-mcp/commit/b2425df6c917436e056e5cc8002ce684fc898694))
- **(cli)** add notify command for testing desktop notifications - ([687f7d2](https://github.com/codefuturist/email-mcp/commit/687f7d26449d97d56bd9d94b7e67f3b798b8e13e))
- **(cli)** add interactive MCP client installation command - ([e2369c7](https://github.com/codefuturist/email-mcp/commit/e2369c7f03df1e506b0bb11e0e5c471a0313ec6b))
- **(cli)** add interactive account CRUD and config edit commands - ([aaa8af5](https://github.com/codefuturist/email-mcp/commit/aaa8af501e7738cf049bd0b4a29ee74f0dbee3bb))
- **(hooks)** add customizable presets and static rule matching - ([138c08e](https://github.com/codefuturist/email-mcp/commit/138c08e0708f49e795e036e2245022fe060a0950))
- **(watcher)** add IMAP IDLE monitoring with AI triage - ([5ed0388](https://github.com/codefuturist/email-mcp/commit/5ed0388ccb0a781220407b3800723bf8191eb2f9))
- add AI-optimised email tools and context improvements - ([d7b01a4](https://github.com/codefuturist/email-mcp/commit/d7b01a48e57491d68ac605583ede6c1a92b2b70d))
- add provider-aware label management (ProtonMail/Gmail/IMAP keywords) - ([85609e5](https://github.com/codefuturist/email-mcp/commit/85609e5f181ea3c01ef26b4fe27a69bafb549141))
- add IMAP move/delete reliability and find_email_folder tool - ([3886bac](https://github.com/codefuturist/email-mcp/commit/3886bacc83eb8b4200f16695468e9029ade32c40))

#### 🐛 Bug Fixes

- **(cli)** add TTY guard and fix IMAP STARTTLS display - ([d9bca69](https://github.com/codefuturist/email-mcp/commit/d9bca695af07e311ec249379827c175e8dac483b))
- virtual folder detection and find_email_folder reliability - ([3c44c22](https://github.com/codefuturist/email-mcp/commit/3c44c226e7b3bf2666479e4d5761c8777d8c5e9c))

#### 📚 Documentation

- update tool count to 42 in README - ([4e6910c](https://github.com/codefuturist/email-mcp/commit/4e6910c04a8dd46efc739079c8e6aa613a7edfaf))
- add pnpm install and usage instructions - ([13c8d4b](https://github.com/codefuturist/email-mcp/commit/13c8d4bf3006fa4fb5f014eb630006a478082a23))

- - -
## [v0.1.7](https://github.com/bitfloo/mailoo/compare/208362959506aab9b5c5e4a327fa922aed90112c..v0.1.7) - 2026-09-29
#### 🐛 Bug Fixes
- (**scheduler**) keep a claim alive while its email is being sent - ([669b051](https://github.com/bitfloo/mailoo/commit/669b051447540966b941fc9584a093aa1db83060)) - Mike, Cursor
- (**scheduler**) keep the pending cap when schedule() calls run in parallel - ([b714934](https://github.com/bitfloo/mailoo/commit/b7149340e70e806c3f6eb2e26ee578bd46feb350)) - Mike, Cursor
- (**scheduler**) send a due email at most once when two checks overlap - ([e8fa0e2](https://github.com/bitfloo/mailoo/commit/e8fa0e21c1bb5b13152025254067c7205883a7a9)) - Mike, Cursor
- pin clack so cancelled prompts stay out of the value type - ([20b910f](https://github.com/bitfloo/mailoo/commit/20b910f8e0ca13a6a1cc865061c43a70f2949d9e)) - Mike, Cursor
- pin clack so cancelled prompts stay out of the value type - ([e50bb68](https://github.com/bitfloo/mailoo/commit/e50bb68d0c88b15d9601c9b2592bed61ff4ff1a3)) - Mike, Cursor
#### ⏪ Reverts
- take the clack pin off develop - ([4d70713](https://github.com/bitfloo/mailoo/commit/4d7071389f0f06841584ba7bca93737a5114aae2)) - Mike, Cursor
#### 📚 Documentation
- (**changelog**) date the 0.1.7 release - ([2d57c50](https://github.com/bitfloo/mailoo/commit/2d57c50a9e424f768ce062b7110fde03fc887710)) - Mike, Claude Opus 5.5
- (**changelog**) file the at-least-once scheduler note under Unreleased - ([3552089](https://github.com/bitfloo/mailoo/commit/3552089b87f362efb3b1d780c1c3990460993846)) - Mike, Claude Opus 5.5
- (**readme**) name the 0.1.7 image tag - ([0faba3a](https://github.com/bitfloo/mailoo/commit/0faba3a7f48d278e8fb4f8bee4cd12f7042e4697)) - Mike, Claude Opus 5.5
- (**readme**) point the M8ven badge at its canonical path - ([5d162db](https://github.com/bitfloo/mailoo/commit/5d162db9286b2085a9a1559d1561ee3067c4b9df)) - Mike, Claude Opus 5.5
- (**readme**) include other server processes in the scheduler claim note - ([f23ab14](https://github.com/bitfloo/mailoo/commit/f23ab1425b25e0926da67fb52b1093de0b843bdc)) - Mike, Claude Opus 5.5
- (**readme**) pull the published image from ghcr - ([579c0e6](https://github.com/bitfloo/mailoo/commit/579c0e601514ef4e82dca5359053b29396e72ad4)) - Mike, Claude Opus 5.5
- (**readme**) describe how the scheduler claims a queued email - ([2969aa0](https://github.com/bitfloo/mailoo/commit/2969aa035d0a5220c9bc7099a9e3e36fe618cf60)) - Mike, Cursor
- add M8ven verified badge to README - ([2083629](https://github.com/bitfloo/mailoo/commit/208362959506aab9b5c5e4a327fa922aed90112c)) - Claude, Claude Opus 5.5
#### Tests
- (**http**) drop the unreachable checks in the http command helpers - ([0ca2953](https://github.com/bitfloo/mailoo/commit/0ca2953174905cd04063ae43616dcd65896c9121)) - Mike, Cursor
- (**http**) let the http command tests wait on the listen line, not a wall-clock race - ([3a305d5](https://github.com/bitfloo/mailoo/commit/3a305d5805a234d4e7e15e86d9ff080e62ca8099)) - Mike, Cursor
- (**scheduler**) pin the cancel error messages - ([bbb8acf](https://github.com/bitfloo/mailoo/commit/bbb8acf172db37eaea5401bf01b93d1a5deabef2)) - Mike, Cursor
- (**scheduler**) advance two stale windows in the renewal test - ([b087328](https://github.com/bitfloo/mailoo/commit/b08732897d42ee110a8328c97ed620f2e094b36a)) - Mike, Cursor
- (**scheduler**) remove the test state directory after the whole file - ([9a61a91](https://github.com/bitfloo/mailoo/commit/9a61a9149cbe3dd933bac691bf7921c65e9f5985)) - Mike, Cursor
#### ♻️ Refactoring
- (**scheduler**) name the cancel errors once - ([9362157](https://github.com/bitfloo/mailoo/commit/9362157d1a3eb55d25d2cf7e72de55d68f4ad4b6)) - Mike, Cursor
- (**scheduler**) keep treating an unreadable send time as due - ([895e6a9](https://github.com/bitfloo/mailoo/commit/895e6a9c57078b244cd9a1c6090ab091f8aa3246)) - Mike, Cursor
- (**scheduler**) split the queue check and cancel into small steps - ([26d9977](https://github.com/bitfloo/mailoo/commit/26d99777579757a1487a3328eaf444f2e044be9a)) - Mike, Cursor

- - -

## [v0.1.6](https://github.com/bitfloo/mailoo/compare/f8d3205e5c0fa2fb5ad7346b0a8b09953ed0e2e6..v0.1.6) - 2026-09-28
#### 🐛 Bug Fixes
- (**alerts**) refuse webhooks to the IPv6 dummy prefix - ([8abaf2e](https://github.com/bitfloo/mailoo/commit/8abaf2e9bdcb6953b76d5e5aff1058ec79367e72)) - Mike, Cursor
- (**alerts**) refuse discard-only and SRv6 webhook addresses - ([c67d3cd](https://github.com/bitfloo/mailoo/commit/c67d3cd869a4d346d0da36899d3de314a95e3421)) - Mike, Cursor
- (**alerts**) refuse local-use NAT64 webhook addresses - ([080068c](https://github.com/bitfloo/mailoo/commit/080068c68ca6f29cc4be88ed285d10555513d2d5)) - Mike, Cursor
- (**alerts**) report a failed webhook lookup as a lookup failure - ([31f6245](https://github.com/bitfloo/mailoo/commit/31f6245bf0c3ad5476607999104cbbc93cb828a9)) - Mike, Cursor
- (**alerts**) refuse shared and embedded private webhook addresses - ([90ddc6d](https://github.com/bitfloo/mailoo/commit/90ddc6deb6270eeebf688da764ba75532a9f7401)) - Mike, Cursor
- (**alerts**) pin webhook connections to the checked address - ([399ee40](https://github.com/bitfloo/mailoo/commit/399ee409c83350adcb5010ee2fa21dd61c6c213b)) - Mike, Cursor
- (**alerts**) keep non-ASCII text intact in macOS notifications - ([a6db295](https://github.com/bitfloo/mailoo/commit/a6db295fba83e96b3f669eab1e2a50fd70038022)) - Mike, Cursor
- (**alerts**) validate alert settings before storing them - ([8ed0d10](https://github.com/bitfloo/mailoo/commit/8ed0d1013c8190d67c7b4ecf1aeaf9fc5be6aaca)) - Mike, Cursor
- (**alerts**) refuse non-global webhook addresses - ([efed96a](https://github.com/bitfloo/mailoo/commit/efed96a331c39cb2c391ae36228eddd9cfdef910)) - Mike, Cursor
- (**attachments**) let parallel saves share a new directory - ([ec77ec5](https://github.com/bitfloo/mailoo/commit/ec77ec50e8af6987a6d10f65c43126c885f8e41b)) - Mike, Cursor
- (**attachments**) report savePath lstat and mkdir failures without the server path - ([f373ca3](https://github.com/bitfloo/mailoo/commit/f373ca39d665c16c2ebf699ca0a04d426071b700)) - Mike, Cursor
- (**attachments**) report the filesystem error when savePath cannot be written - ([dfed628](https://github.com/bitfloo/mailoo/commit/dfed6289b809469c01bb512216b8144f3084f96e)) - Mike, Cursor
- (**attachments**) cap saved file names at 255 UTF-8 bytes - ([d5813b9](https://github.com/bitfloo/mailoo/commit/d5813b9d72d4e75453606052c6bd85b9d033011c)) - Mike, Cursor
- (**attachments**) refuse files from application data directories - ([823f445](https://github.com/bitfloo/mailoo/commit/823f4452b6f1e300b56bc7bc34f874fd9cd5d8b0)) - Mike, Cursor
- (**attachments**) refuse a working directory that resolves to a top-level directory - ([a75705c](https://github.com/bitfloo/mailoo/commit/a75705c1bce86181d37f0f18d1e9ab86ed097fff)) - Mike, Cursor
- (**attachments**) keep savePath inside the working directory - ([026e0ca](https://github.com/bitfloo/mailoo/commit/026e0cabf2d98e02ebf01a367595a386f62140ca)) - Mike, Cursor
- (**attachments**) validate outgoing attachment files - ([6483555](https://github.com/bitfloo/mailoo/commit/6483555748454bd3adbfe32c8e980c0e3e2b9a64)) - Mike, Cursor
- (**build**) keep the test harness out of the published package - ([58ec5d4](https://github.com/bitfloo/mailoo/commit/58ec5d4b88358b8b8ec9e19806516735cceacfb8)) - Mike, Cursor
- (**calendar**) list every add_to_calendar status from one list - ([e4aa153](https://github.com/bitfloo/mailoo/commit/e4aa1535ca10168c618a36e8b3af7333a98556a4)) - Mike, Cursor
- (**calendar**) keep entities in plain-text event notes - ([d650e32](https://github.com/bitfloo/mailoo/commit/d650e32ebcc9d17d02eed36c7de7dcebea87a53d)) - Mike, Cursor
- (**ci**) honor the image build flag - ([d016f30](https://github.com/bitfloo/mailoo/commit/d016f30153300a1f7380c55b79d355514b24dff3)) - Mike, Cursor
- (**cli**) run scheduler install without a shell - ([91f85c7](https://github.com/bitfloo/mailoo/commit/91f85c723326af660d97e80f4b40ebfe9ac0461f)) - Mike, Cursor
- (**config**) write a symlinked config by updating the target file - ([2f48ba8](https://github.com/bitfloo/mailoo/commit/2f48ba81e11acdc9f09b98186212e49471894146)) - Mike, Cursor
- (**config**) load symlinked config files without changing their mode - ([706b797](https://github.com/bitfloo/mailoo/commit/706b7972ae2a2ecce04a6ee832e685549c8a0056)) - Mike, Cursor
- (**config**) write the config file owner-only - ([8ea9d1c](https://github.com/bitfloo/mailoo/commit/8ea9d1cc015df6752ec805586e265ba006d79096)) - Mike, Cursor
- (**deps**) refresh production dependencies - ([1744eb7](https://github.com/bitfloo/mailoo/commit/1744eb79ddc9015dde1976765043d273d5e0e8a4)) - Mike, Cursor
- (**docker**) pin the base image digest - ([61fce6e](https://github.com/bitfloo/mailoo/commit/61fce6e7b9c6e236f9410fa13560cbee31466b1f)) - Mike, Cursor
- (**email**) keep message text that follows a large HTML prefix - ([a7a540b](https://github.com/bitfloo/mailoo/commit/a7a540bfec3a20ef98c1d506f2ce02d354a4398e)) - Mike, Cursor
- (**email**) delimit external mail text in results - ([4757403](https://github.com/bitfloo/mailoo/commit/4757403cee00255c62c2519723b9015f769f717b)) - Mike, Cursor
- (**email**) bound HTML conversion of message bodies - ([42c2cf2](https://github.com/bitfloo/mailoo/commit/42c2cf21227506995cd7ec0349e63987e73b654f)) - Mike, Cursor
- (**http**) name the allowlist when a public host is refused - ([0ab80e8](https://github.com/bitfloo/mailoo/commit/0ab80e88e8175191efc9cf818622816297137fc7)) - Mike, Cursor
- (**http**) require a token when the allowlist names a public host - ([0afe652](https://github.com/bitfloo/mailoo/commit/0afe652dd23b368798f981fbf419295c26b064fc)) - Mike, Cursor
- (**http**) accept proxied hosts on a published port - ([3234a5c](https://github.com/bitfloo/mailoo/commit/3234a5c076f2dedced079c08403b66c13e3b169e)) - Mike, Cursor
- (**http**) share account state across sessions - ([8dbfde6](https://github.com/bitfloo/mailoo/commit/8dbfde668d7d6ac8338d5103b7ad4590b57cc040)) - Mike, Cursor
- (**http**) isolate session state and expire it - ([6acac7a](https://github.com/bitfloo/mailoo/commit/6acac7a7695e63224bd54bae4968ed986420fd66)) - Mike, Cursor
- (**http**) default to loopback; require a bearer token for other addresses - ([73be2a1](https://github.com/bitfloo/mailoo/commit/73be2a1161b3ae6c634deb5ae401040834f4ccb3)) - Mike, Cursor
- (**imap**) require STARTTLS when the account sets starttls - ([ba0fc87](https://github.com/bitfloo/mailoo/commit/ba0fc87048e86ccf3c9dace11f7ebb8de40b9dc7)) - Mike, Cursor
- (**imap**) allow labels such as \Starred and Receipts (2024) - ([e26f931](https://github.com/bitfloo/mailoo/commit/e26f9312627132984d45f030e19a87228a52e7f6)) - Mike, Cursor
- (**imap**) allow mailbox names that imapflow quotes - ([4e7e2de](https://github.com/bitfloo/mailoo/commit/4e7e2de5ff3d164eb3592b8b66a308e8ad0c26b4)) - Mike, Cursor
- (**imap**) keep certificate verification on unless opted out - ([43d2652](https://github.com/bitfloo/mailoo/commit/43d2652487e2c0efaeb5c12979f7a075eb4b02fa)) - Mike, Cursor
- (**imap**) validate single-message ids and mailbox names - ([1c17f60](https://github.com/bitfloo/mailoo/commit/1c17f60f3bcb4945439243892adb9c691486c259)) - Mike, Cursor
- (**labels**) keep system flags out of label tools - ([0cb7b6a](https://github.com/bitfloo/mailoo/commit/0cb7b6abb82f04f71325e1bc50ecdae1dd79150b)) - Mike, Cursor
- (**mcp**) treat get_emails as an error only when no message was fetched - ([a3b1d3e](https://github.com/bitfloo/mailoo/commit/a3b1d3e124d214dc95a5225526e4b11328a4443d)) - Mike, Cursor
- (**mcp**) stop offering resource subscriptions - ([bca63a9](https://github.com/bitfloo/mailoo/commit/bca63a9c751a88c79550023ed8369c597a7e4a59)) - Mike, Cursor
- (**mcp**) return isError when a tool call fails - ([ee26975](https://github.com/bitfloo/mailoo/commit/ee2697507e13ed3b452be3cf8aa18cd88e812c14)) - Mike, Cursor
- (**mcp**) correct tool descriptions that cited missing behaviour - ([0320292](https://github.com/bitfloo/mailoo/commit/0320292bf5fa0c09e33dcfc5c60533c6e9448989)) - Mike, Cursor
- (**mcp**) omit write tools when read_only is set - ([5920c56](https://github.com/bitfloo/mailoo/commit/5920c56b270d81390f811540263746faafed11c8)) - Mike, Cursor
- (**mcp**) declare every tool hint as an explicit boolean - ([4deb875](https://github.com/bitfloo/mailoo/commit/4deb875fbae1520ab16c4d0809e8e2442c13522c)) - Mike, Cursor
- (**scheduler**) refuse impossible calendar dates in send_at - ([c75d50f](https://github.com/bitfloo/mailoo/commit/c75d50f0d67a71b23d546847d11427f6476ab885)) - Mike, Cursor
- (**scheduler**) accept a UTC send time that omits seconds - ([7a930b3](https://github.com/bitfloo/mailoo/commit/7a930b3c28a1f425926cb3d54fc2ca2a90db230a)) - Mike, Cursor
- (**scheduler**) do not let failed messages fill the pending cap - ([b204281](https://github.com/bitfloo/mailoo/commit/b204281736459df1393c5e6917a32e20520669d8)) - Mike, Cursor
- (**scheduler**) validate scheduled mail before writing the queue - ([b99b502](https://github.com/bitfloo/mailoo/commit/b99b502187666d73beff495f9d17d29ddf3aee0d)) - Mike, Cursor
- (**sieve**) reject C1 controls in script names - ([b4f77f3](https://github.com/bitfloo/mailoo/commit/b4f77f36df1aa47ce1ba9bf6e2f2e3a8bae36a94)) - Mike, Cursor
- (**sieve**) check script names and size before sending them - ([029cc7e](https://github.com/bitfloo/mailoo/commit/029cc7eba130f8077616b3650dd7df7a4ceecc80)) - Mike, Cursor
- (**smithery**) forward only MCP_EMAIL_ settings into the environment - ([ac856e4](https://github.com/bitfloo/mailoo/commit/ac856e4ab298745e40234b40855c59934d218d3f)) - Mike, Cursor
- (**templates**) wait for the audit log when applying a template - ([bd84606](https://github.com/bitfloo/mailoo/commit/bd846065a8eb80127083fafcbf03ed63a982e00c)) - Mike, Cursor
- (**test**) type the integration setup against Vitest 4 - ([3e5650a](https://github.com/bitfloo/mailoo/commit/3e5650a7082527f994ef6b79be9ac44c1e57cfbf)) - Mike, Cursor
- do not replace a crontab that cannot be read - ([ece0b57](https://github.com/bitfloo/mailoo/commit/ece0b57b0971b0cf45fa27c631ff5bfef61b5cb4)) - Mike, Cursor
- keep classifier mail fields identical to the message - ([180e6d3](https://github.com/bitfloo/mailoo/commit/180e6d347226d146a7e6eae6d4590704a4c1cb17)) - Mike, Cursor
- mark a listed or searched page as one external block - ([3e68f16](https://github.com/bitfloo/mailoo/commit/3e68f16c7f9aa28b434649a3e38f31342326cdfd)) - Mike, Cursor
- return attachment filenames and file bytes unchanged - ([fd00bad](https://github.com/bitfloo/mailoo/commit/fd00bade88698ff28f85f6b107e0e31b642f7d3d)) - Mike, Cursor
- load the System One SDK only when classification is on - ([c7d460a](https://github.com/bitfloo/mailoo/commit/c7d460ae3955ce81aaad1655f80d2b650ab37a3a)) - Mike, Cursor
- declare the published npm package in server.json - ([98f407c](https://github.com/bitfloo/mailoo/commit/98f407cb1ee1d825b9a99d01a89a962cef086dbe)) - Mike, Cursor
- refuse savePath writes outside a specific directory - ([c5084fe](https://github.com/bitfloo/mailoo/commit/c5084fe5e19973ac3004e904ff0ddd64a7726607)) - Mike, Cursor
#### 📚 Documentation
- (**body**) say the HTML fallback is sanitized - ([f590e2f](https://github.com/bitfloo/mailoo/commit/f590e2fa16873dcc016d6926b48a57a2f4abc08e)) - Mike, Cursor
- (**changelog**) list the unreleased changes under 0.1.6 - ([92cac06](https://github.com/bitfloo/mailoo/commit/92cac0688899f1a7d89105cad83cf9f4477e3aa8)) - Mike, Claude Opus 5.5
- (**changelog**) say unmatched mail is notified without a sampling client - ([cc698de](https://github.com/bitfloo/mailoo/commit/cc698de9fe81512c62c15ea5ce6e0393fef3215c)) - Mike, Cursor
- (**config**) keep the writer comment on the write - ([459528b](https://github.com/bitfloo/mailoo/commit/459528b7700fbe90dbcf6d0d15c07e4f31ba548a)) - Mike, Cursor
- (**contributing**) name the register-test mock a new tool file needs - ([4ce22e8](https://github.com/bitfloo/mailoo/commit/4ce22e89fdda32dd3ef98d76798f72f16ce9d65c)) - Mike, Cursor
- (**contributing**) name the read_only list a read-only tool joins - ([8ea5421](https://github.com/bitfloo/mailoo/commit/8ea54214b6f4b12a984ee95fd4a8138c363f21e2)) - Mike, Cursor
- (**http**) show the npm command for the HTTP transport - ([2d466f1](https://github.com/bitfloo/mailoo/commit/2d466f193786632fd29cfa039a0f31988afecd0e)) - Mike, Cursor
- (**http**) state when a public allowlist name needs a token - ([fbad6d5](https://github.com/bitfloo/mailoo/commit/fbad6d55dce9a21e29d3d2949540b98953ed8978)) - Mike, Cursor
- (**http**) state the listen port rule once - ([459c8e0](https://github.com/bitfloo/mailoo/commit/459c8e050dd25e0564f1daaab6a5bf996fea0882)) - Mike, Cursor
- (**scheduler**) drop the extra clause on the recipient cap - ([1340b59](https://github.com/bitfloo/mailoo/commit/1340b5905d99dde7f9de0c388cbea7653dffcac2)) - Mike, Cursor
- (**scheduler**) record why the schedule caps exist - ([5924afa](https://github.com/bitfloo/mailoo/commit/5924afa5beb4cbdf06a7bf4f3be7168aa7750eb4)) - Mike, Cursor
- say what tls and starttls do when STARTTLS is missing - ([75f5213](https://github.com/bitfloo/mailoo/commit/75f52134fd33ca86ff916561d54375f2d62fd2cf)) - Mike, Cursor
- note attachment names and bytes stay unmarked - ([89cc0d6](https://github.com/bitfloo/mailoo/commit/89cc0d6ae524424af883e282311fc2f62a731ee1)) - Mike, Cursor
- rewrap the read_only and savePath notes - ([47636e0](https://github.com/bitfloo/mailoo/commit/47636e0c5e76b1319e1a2c95f8c31a002671b419)) - Mike, Cursor
- correct rate limit, sieve port, audit, and config mode notes - ([2d75b93](https://github.com/bitfloo/mailoo/commit/2d75b93b930301de66553a18c2950dbfd7f157f2)) - Mike, Cursor
- describe when IMAP and SMTP require STARTTLS - ([ba37973](https://github.com/bitfloo/mailoo/commit/ba3797332a5d18e618861ea78b65bcf1cf9c69be)) - Mike, Cursor
- correct the read_only savePath and roster notes - ([db94a6a](https://github.com/bitfloo/mailoo/commit/db94a6a3c962a4525001e64d157fc1f87f7e8e32)) - Mike, Cursor
- explain how to refresh the MCP catalog baseline - ([b45a776](https://github.com/bitfloo/mailoo/commit/b45a776e917204249b9726614045a347df041234)) - Mike, Cursor
- name the extra webhook ranges that are refused - ([604d1a1](https://github.com/bitfloo/mailoo/commit/604d1a167494b23192fd4adef32915cf0d124070)) - Mike, Cursor
- link allow_private_webhooks to its configuration section - ([2e9a859](https://github.com/bitfloo/mailoo/commit/2e9a85907609ed4cb76584be5f0c5611085adeab)) - Mike, Cursor
- correct why webhook posts disable socket reuse - ([833fd36](https://github.com/bitfloo/mailoo/commit/833fd3698cf275f6c0da5667a8e1c5a661108d5c)) - Mike, Cursor
- keep webhook range labels on the lines that add them - ([7a3158c](https://github.com/bitfloo/mailoo/commit/7a3158c5e8f180a1d471cac2f40a623d0d22398c)) - Mike, Cursor
- name the shared top-level directories that are refused - ([9d8c015](https://github.com/bitfloo/mailoo/commit/9d8c0154fbc3297c35ad8435d75c57033ba7a4c7)) - Mike, Cursor
- note HTTP hooks sample the newest connected client - ([c6f4958](https://github.com/bitfloo/mailoo/commit/c6f4958284df3247c774ffa617616faad8b4861e)) - Mike, Cursor
- say when hooks start and why sampling follows the newest client - ([957091b](https://github.com/bitfloo/mailoo/commit/957091b2c4a93436bb91034b26ae50ae9bae903a)) - Mike, Cursor
- note external mail text and crontab install safety - ([80ca4f1](https://github.com/bitfloo/mailoo/commit/80ca4f17676de5c98aadd35189714b3115858bf3)) - Mike, Cursor
- record failed fetches and notifications as error results - ([1c03e8f](https://github.com/bitfloo/mailoo/commit/1c03e8fcdbe86530ca7c2d90a8174e6971870a25)) - Mike, Cursor
- correct the security notes - ([1ac7973](https://github.com/bitfloo/mailoo/commit/1ac7973ad5e567fc67380f3bc073acfb718984ed)) - Mike, Cursor
- use reserved domains in examples - ([632c4d3](https://github.com/bitfloo/mailoo/commit/632c4d3465aeda66e455965815a2f7baf7562877)) - Mike, Cursor
- list network destinations, processes, and files - ([105d17b](https://github.com/bitfloo/mailoo/commit/105d17b884e616316809edeade716601070babfe)) - Mike, Cursor
- make npx the install path - ([81f7919](https://github.com/bitfloo/mailoo/commit/81f7919d54fd6a6468e10916493a893cf9991ce2)) - Mike, Cursor
- describe HTTP allowlists for proxies and Docker - ([a66d247](https://github.com/bitfloo/mailoo/commit/a66d2474391c9909a5a205e522da5d37156bbb4b)) - Mike, Cursor
- separate added features from HTTP behaviour notes - ([bd15aa9](https://github.com/bitfloo/mailoo/commit/bd15aa906de0ecdd5d09113bb5ed8c0f198d062d)) - Mike, Cursor
- name the refused webhook address ranges - ([95a8d60](https://github.com/bitfloo/mailoo/commit/95a8d60836a7ec0e0f4dcc26fe0793eba7bd972d)) - Mike, Cursor
- note why bracketed IPv6 hosts are unwrapped - ([ed0d67d](https://github.com/bitfloo/mailoo/commit/ed0d67d6704a367ac7002d1ed776027fff640fc0)) - Mike, Cursor
- record webhook checks for non-global hosts - ([cec0a9e](https://github.com/bitfloo/mailoo/commit/cec0a9ed0f973aefd86a5a48f11fcbfc4a2a4d4a)) - Mike, Cursor
- describe allow_private_webhooks - ([6c994f3](https://github.com/bitfloo/mailoo/commit/6c994f39b0bd703215f89c851917ee5a4632ecf8)) - Mike, Cursor
- describe savePath write limits - ([87b37f0](https://github.com/bitfloo/mailoo/commit/87b37f088e267c6650daebb8c30858e43d249898)) - Mike, Cursor
- record that a single-message id must be one UID - ([f314c6c](https://github.com/bitfloo/mailoo/commit/f314c6c5a90715ef27543294082bed165be7137c)) - Mike, Cursor
- record schedule, alert, and sieve limits - ([87cd6ce](https://github.com/bitfloo/mailoo/commit/87cd6ceb1aacb2e62c21dd9c90ff9f7d1b5b0ada)) - Mike, Cursor
- record config file modes and the permission warning - ([f437d5e](https://github.com/bitfloo/mailoo/commit/f437d5e35cbc687b9f94aa8813ee3bc0e5afd3bc)) - Mike, Cursor
- index repo rules in AGENTS.md - ([2e50bf8](https://github.com/bitfloo/mailoo/commit/2e50bf88cabce0df794620168f0877fc46a54129)) - Mike, Claude Opus 5.5
#### Tests
- (**alerts**) test the webhook connect-time lookup in its own module - ([bd36f42](https://github.com/bitfloo/mailoo/commit/bd36f426111a2cae56e7a8122ea5a5874efd33b8)) - Mike, Cursor
- (**alerts**) name why the allowed IPv6 sibling is outside both blocks - ([f4eee04](https://github.com/bitfloo/mailoo/commit/f4eee0416870aa5f0b47f7dc7c212dba35492c21)) - Mike, Cursor
- (**alerts**) name the prefix-length probes by the bit they catch - ([79bec81](https://github.com/bitfloo/mailoo/commit/79bec8183b6fd29f0d4d11fa0fa823bd77daa34e)) - Mike, Cursor
- (**alerts**) pin each new webhook prefix to its exact length - ([091f1c7](https://github.com/bitfloo/mailoo/commit/091f1c7af6b9caa5dd12fd4673b11b46a77ba7c2)) - Mike, Cursor
- (**alerts**) pin desktop notification argv and env per platform - ([733ec61](https://github.com/bitfloo/mailoo/commit/733ec610135120660dc4bee2c410b008d2c5925a)) - Mike, Cursor
- (**attachments**) refuse an outgoing attachment swapped for a symlink after the check - ([51f7a31](https://github.com/bitfloo/mailoo/commit/51f7a31026de55942961b84135226dfa09d6bf0b)) - Mike, Cursor
- (**attachments**) refuse a file that appears between the checks and the open - ([62f10a0](https://github.com/bitfloo/mailoo/commit/62f10a012ec064b97762180576dd3a278f0b2a35)) - Mike, Cursor
- (**attachments**) restore the locked directory mode in the test - ([5133b30](https://github.com/bitfloo/mailoo/commit/5133b3055da3434615636410b913b1c9d58db857)) - Mike, Cursor
- (**attachments**) keep only the bitmask reason on the open - ([b1fc55a](https://github.com/bitfloo/mailoo/commit/b1fc55afb9663f05283a25fc766c8609e72f541a)) - Mike, Cursor
- (**attachments**) save a leading-dot attachment name without the dot - ([a68d56e](https://github.com/bitfloo/mailoo/commit/a68d56ef8a940a467c5619660d9d6d5c81dd7037)) - Mike, Cursor
- (**attachments**) refuse application-data paths that differ in letter case - ([6dd9f29](https://github.com/bitfloo/mailoo/commit/6dd9f299db49c35cc9a103f59cf9e9241c16a03f)) - Mike, Cursor
- (**attachments**) keep temporary files out of the repository - ([adac7df](https://github.com/bitfloo/mailoo/commit/adac7df43fe618e037cb965cf5f289f1bafbe83b)) - Mike, Cursor
- (**ci**) drop workflow existence checks the read already covers - ([85a162d](https://github.com/bitfloo/mailoo/commit/85a162dd43a7bf1853b0ba63fd63a7fc7c5da897)) - Mike, Cursor
- (**cli**) drop a comment that names no file - ([33e0f41](https://github.com/bitfloo/mailoo/commit/33e0f41be11b52adc619bc5f6f2cf154d68309a8)) - Mike, Cursor
- (**cli**) keep a second scheduler line out of crontab - ([b124562](https://github.com/bitfloo/mailoo/commit/b1245620e4692734f7c1c9bc2ca5564f3ed4240c)) - Mike, Cursor
- (**cli**) run crontab install against a temporary crontab - ([3e0da91](https://github.com/bitfloo/mailoo/commit/3e0da91a6ebffe55fd0f7cfb60d4c2f10ebfcd7f)) - Mike, Cursor
- (**cli**) catch assigned imports and absolute shell paths - ([956e21f](https://github.com/bitfloo/mailoo/commit/956e21f6ac3cd6becf079b2f63d8c8775d050484)) - Mike, Cursor
- (**config**) name chmod 600 and the path in the warning - ([0b66ccc](https://github.com/bitfloo/mailoo/commit/0b66cccebc3eafac49bf4b80057f0931a3d1ab3f)) - Mike, Cursor
- (**config**) pin the permission warning to group/other bits - ([6dfc5ad](https://github.com/bitfloo/mailoo/commit/6dfc5adec844789a0b49e708376b061bac90d617)) - Mike, Cursor
- (**email**) state why a fourth entity layer stays - ([c481359](https://github.com/bitfloo/mailoo/commit/c4813592a1535fac07ce5727181e2faecaa72a9b)) - Mike, Cursor
- (**email**) pin the entity decode pass ceiling in both directions - ([43ae22c](https://github.com/bitfloo/mailoo/commit/43ae22c20826e5838444b06ee4a5471371fa162d)) - Mike, Cursor
- (**email**) keep paragraph text after a large inline image - ([37cb60c](https://github.com/bitfloo/mailoo/commit/37cb60cc961610c1ae51cf17ca011f7755e0d08e)) - Mike, Cursor
- (**http**) pin port-agnostic bind hosts and invalid allowlist entries - ([f2f68c1](https://github.com/bitfloo/mailoo/commit/f2f68c158a3106beac7f1b1c24fe97cf55654d30)) - Mike, Cursor
- (**http**) sample on the newest client and fall back after it closes - ([4049a2a](https://github.com/bitfloo/mailoo/commit/4049a2a7ceb3024a65071bbb5ed57296ded8f64b)) - Mike, Cursor
- (**http**) check the http command refuses a foreign Host - ([5c89b39](https://github.com/bitfloo/mailoo/commit/5c89b39dc9bed0a1d986733ecf43fb4ada7fa9ee)) - Mike, Cursor
- (**identity**) bind environment descriptions to smithery.yaml - ([abb7091](https://github.com/bitfloo/mailoo/commit/abb7091877ac9620845b414678c1f3a27f886af9)) - Mike, Cursor
- (**imap**) cover mailbox and label names that contain punctuation - ([0cae614](https://github.com/bitfloo/mailoo/commit/0cae614cde8c70cedc9cc3e97e79f41ce1441ceb)) - Mike, Cursor
- (**integration**) drop a comment the test already states - ([64e2f39](https://github.com/bitfloo/mailoo/commit/64e2f39ad927b1e16c14e77a549daef947e4fe78)) - Mike, Cursor
- (**integration**) require the plain-mode message before fetch and flags - ([d78df3f](https://github.com/bitfloo/mailoo/commit/d78df3f85ee0c9d978d04a7f1b5b33021bcdf4e9)) - Mike, Cursor
- (**integration**) keep \Seen off when read_only get_email sets markRead - ([54f2a95](https://github.com/bitfloo/mailoo/commit/54f2a95965a98118f79a63e763e41f3174056ac0)) - Mike, Cursor
- (**labels**) pin the Gmail removeLabel guard - ([c290735](https://github.com/bitfloo/mailoo/commit/c290735f0e15fae11aeb7af6f58e64c9318721cb)) - Mike, Cursor
- (**mcp**) drop the hard-coded catalog counts - ([889df81](https://github.com/bitfloo/mailoo/commit/889df810c5c4495f7aaddde33d49e4406b03a505)) - Mike, Cursor
- (**mcp**) limit the get_emails error note to an empty fetch - ([eeb78ba](https://github.com/bitfloo/mailoo/commit/eeb78ba2ba5dd911b74ed73b39700d517ce2ac1a)) - Mike, Cursor
- (**mcp**) bind the documented read_only roster to the catalog - ([e8261e2](https://github.com/bitfloo/mailoo/commit/e8261e2d2ebfc68b6f668f8278a8db3802ac976b)) - Mike, Cursor
- (**mcp**) sort the catalog snapshot by name and URI - ([261c3f6](https://github.com/bitfloo/mailoo/commit/261c3f63e14681331ffa9d68cf445ca28098c5bc)) - Mike, Cursor
- (**mcp**) compare the catalog to a file snapshot - ([289a266](https://github.com/bitfloo/mailoo/commit/289a266cf11bbd870d15ed6fd3f8d46d99b07c38)) - Mike, Cursor
- (**mcp**) fold boolean hint checks into the annotation table - ([fd5a74c](https://github.com/bitfloo/mailoo/commit/fd5a74c9b3ba1399411df9aacdb62cb1153002d6)) - Mike, Cursor
- (**mcp**) reject description names the server does not expose - ([f1cf0bf](https://github.com/bitfloo/mailoo/commit/f1cf0bf016ca0c0b3e843392cb2d4b1eb85fa426)) - Mike, Cursor
- (**scheduler**) keep the pending-cap queue out of the shared directory - ([e856f4d](https://github.com/bitfloo/mailoo/commit/e856f4de05c8753c260874659d0572fa1903a887)) - Mike, Cursor
- (**scheduler**) pin the century leap-year rule and restore two WHYs - ([1a3a4ca](https://github.com/bitfloo/mailoo/commit/1a3a4ca4512eb029be534f1cacf9957e01e76230)) - Mike, Cursor
- (**scheduler**) refuse reply-header line breaks and overlong account names - ([5875594](https://github.com/bitfloo/mailoo/commit/58755948f2b3ad45273c980677b8a3bd781eaad2)) - Mike, Cursor
- (**tls**) create the test certificate with OpenSSL 3.0 as well - ([c13283c](https://github.com/bitfloo/mailoo/commit/c13283c29a22d2134ad6abcbd49a73ea9f9ad7a7)) - Mike, Cursor
- name the localhost bind and the split description - ([77015a5](https://github.com/bitfloo/mailoo/commit/77015a5a35350e1d5cff1df48e0c7cb145e0ebe4)) - Mike, Cursor
- reject shell execution outside execFile and spawn - ([4b9a415](https://github.com/bitfloo/mailoo/commit/4b9a41520b1dac8423b85025becccd2d32bc4168)) - Mike, Cursor
- align session host and delimited mail fixtures - ([3a0d066](https://github.com/bitfloo/mailoo/commit/3a0d066aae34b153c450f1ba5d3389af1e695d26)) - Mike, Cursor
- cover the remaining webhook hosts and body fixtures - ([d121d22](https://github.com/bitfloo/mailoo/commit/d121d221c64d18bc39216e9fa44adbdb46005248)) - Mike, Cursor
#### Build
- (**hooks**) type-check tests before commit - ([ee679ec](https://github.com/bitfloo/mailoo/commit/ee679ec3dba726eb2dd13794deda55e6dc06a7fa)) - Mike, Cursor
- (**ts**) type-check tests as well as src - ([2600736](https://github.com/bitfloo/mailoo/commit/26007366103936f94edce3d0186e5e79291ccd04)) - Mike, Cursor
#### CI
- (**release**) pin the mcp-publisher archive hash - ([76be303](https://github.com/bitfloo/mailoo/commit/76be303e2e2805113646ac1d0ff824bb62769d92)) - Mike, Cursor
- (**scorecard**) keep write permissions on the analysis job - ([dac748b](https://github.com/bitfloo/mailoo/commit/dac748bf0df44b7da1484ed77f8a181644f70297)) - Mike, Cursor
- note why ci-local scans every argument for --image - ([bddac2a](https://github.com/bitfloo/mailoo/commit/bddac2ae1a4403acb547732673bffd4b2840ff38)) - Mike, Cursor
- add CodeQL and Scorecard scans for pull requests and weekly runs - ([0e5c945](https://github.com/bitfloo/mailoo/commit/0e5c9457dc3db3f3bf8e192e2e10b6fa93b80310)) - Mike, Cursor
- pin GitHub Actions to commit SHAs so tags cannot move - ([0012d8e](https://github.com/bitfloo/mailoo/commit/0012d8e24dfc6b46480ba2f61f14fcf4013971bb)) - Mike, Cursor
- pin npm and verify the MCP publisher checksum - ([55010d9](https://github.com/bitfloo/mailoo/commit/55010d953f88773fe3e7ad4644807ef98a4d2504)) - Mike, Cursor
#### ♻️ Refactoring
- (**attachments**) resolve a missing home directory in one place - ([ff033a8](https://github.com/bitfloo/mailoo/commit/ff033a8850736d7ee00153e5db858ca051e60590)) - Mike, Cursor
- (**email**) name the entity-decode pass limit - ([bba89aa](https://github.com/bitfloo/mailoo/commit/bba89aa4077482bdac394130e01d26449dc60009)) - Mike, Cursor
- (**http**) drop the unused per-session queue directory - ([05e5e02](https://github.com/bitfloo/mailoo/commit/05e5e027338d7cf47ab2646f0d5378b2e089e671)) - Mike, Cursor
- (**http**) tidy transport guard and docs - ([8e74bbc](https://github.com/bitfloo/mailoo/commit/8e74bbcacb4b186ea305b1cdfacf05835ba90c0c)) - Mike, Cursor
- (**imap**) omit doSTARTTLS unless STARTTLS is required - ([18865e2](https://github.com/bitfloo/mailoo/commit/18865e247d4e8272606ab3ce90f516e75ba8152a)) - Mike, Cursor
- (**imap**) look up mark_email actions from one list - ([2dd393f](https://github.com/bitfloo/mailoo/commit/2dd393fd2669ffe29d8bb4cccaae195786a30c86)) - Mike, Cursor
- (**imap**) tighten UID helper types and names - ([1d3eee9](https://github.com/bitfloo/mailoo/commit/1d3eee94cdcedce393ba5719c6e8bc1a5afcf73b)) - Mike, Cursor
- (**labels**) drop the unused combined label registrar - ([f7fb983](https://github.com/bitfloo/mailoo/commit/f7fb98369b80b2eaf8113f09f55219b701ecfe71)) - Mike, Cursor
- (**mcp**) drop the repeated markRead note on get_email - ([10e352d](https://github.com/bitfloo/mailoo/commit/10e352d39281bd95434fc3d4749c53c930119ff1)) - Mike, Cursor
- (**mcp**) require the read_only flag on mail tool registration - ([3d14051](https://github.com/bitfloo/mailoo/commit/3d14051c04deba9416c35c5f32b8b9186d438aab)) - Mike, Cursor
- (**mcp**) register reads always and writes only when allowed - ([3c9973a](https://github.com/bitfloo/mailoo/commit/3c9973aa0e4a0af24e48b969ddca5999f0bf8b62)) - Mike, Cursor
- (**mcp**) register tools, resources, and prompts with titles - ([1256bee](https://github.com/bitfloo/mailoo/commit/1256beea54d2e70e5f2483b4d35e7cbe675d5860)) - Mike, Cursor
- (**notifier**) derive urgency levels from the order map - ([c7a5616](https://github.com/bitfloo/mailoo/commit/c7a56163a28371f547beeca0ec17658749f13cd5)) - Mike, Cursor
- (**scheduler**) build the sent directory from the queue path - ([3892978](https://github.com/bitfloo/mailoo/commit/389297883a9b6add59e85c482aea20aaeaad8c3f)) - Mike, Cursor
- (**test**) sort catalog lists on their own keys - ([50b4fc9](https://github.com/bitfloo/mailoo/commit/50b4fc97340f421636547ff7b3117c3044d93b34)) - Mike, Cursor
- (**test**) scan MCP registrations once - ([db8bafc](https://github.com/bitfloo/mailoo/commit/db8bafc34873984d5415696654c292b3fff0dd7d)) - Mike, Cursor
- (**test**) share the MCP catalog registration stub - ([d803dd7](https://github.com/bitfloo/mailoo/commit/d803dd7462ef53206932b273dc8ebab786d43874)) - Mike, Cursor
- share local path checks for attachment reads and saves - ([1c332d5](https://github.com/bitfloo/mailoo/commit/1c332d599681a4f449f995a316034ed2fc7a0236)) - Mike, Cursor
- name the schedule and sieve bounds - ([13e23b4](https://github.com/bitfloo/mailoo/commit/13e23b4c09af934ecdce063718f15c06766cacb4)) - Mike, Cursor
#### Chores
- ignore machine-local agent state - ([f8d3205](https://github.com/bitfloo/mailoo/commit/f8d3205e5c0fa2fb5ad7346b0a8b09953ed0e2e6)) - Mike, Claude Opus 5.5

- - -

## [v0.1.5](https://github.com/bitfloo/mailoo/compare/v0.1.4..v0.1.5) - 2026-09-23
#### Chores
- (**version**) v0.1.4 - ([dbc2b75](https://github.com/bitfloo/mailoo/commit/dbc2b7522668d3fb87bd3652cf249886a7c756fa)) - Mike

- - -

## [v0.1.4](https://github.com/bitfloo/mailoo/compare/7e564afcb0de5ed000de9f32f469432ebc15fb3d..v0.1.4) - 2026-09-23
#### 🐛 Bug Fixes
- (**package**) name the repository Bitfloo/mailoo, as npm provenance requires - ([7e564af](https://github.com/bitfloo/mailoo/commit/7e564afcb0de5ed000de9f32f469432ebc15fb3d)) - Mike, Claude Opus 5.5 (1M context)

- - -

## [v0.1.3](https://github.com/bitfloo/mailoo/compare/09df7206546cd679d78ff99cd40f991c4a077a6e..v0.1.3) - 2026-09-23
#### 🐛 Bug Fixes
- (**release**) set the version before cog commits and tags - ([09df720](https://github.com/bitfloo/mailoo/commit/09df7206546cd679d78ff99cd40f991c4a077a6e)) - Mike, Claude Opus 5.5 (1M context)
#### Chores
- (**package**) write bin in the form npm normalizes it to - ([6d9f4c1](https://github.com/bitfloo/mailoo/commit/6d9f4c1ae7376d21562647faf1ea3240bc0461e1)) - Mike, Claude Opus 5.5 (1M context)

- - -

## [v0.1.2](https://github.com/bitfloo/mailoo/compare/3b384c6210890691b05dfd70de2754382ae8e96e..v0.1.2) - 2026-09-23
#### 🐛 Bug Fixes
- (**registry**) publish under io.github.Bitfloo, the namespace GitHub OIDC grants - ([13bd23a](https://github.com/bitfloo/mailoo/commit/13bd23aa43f351a8878ceb4ebc1ed83c5fbff74b)) - Mike, Claude Opus 5.5 (1M context)
- (**release**) push the v-prefixed tag cog actually creates - ([3b384c6](https://github.com/bitfloo/mailoo/commit/3b384c6210890691b05dfd70de2754382ae8e96e)) - Mike, Claude Opus 5.5 (1M context)
#### 📚 Documentation
- (**config**) MCP_EMAIL_SAVE_TO_SENT files into sent_mailbox when set - ([e7c6312](https://github.com/bitfloo/mailoo/commit/e7c631255a44f914144381a64e1b8013d7144253)) - Mike, Claude Opus 5.5 (1M context)
#### CI
- (**release**) publish to npm through trusted publishing, no token - ([a2020a8](https://github.com/bitfloo/mailoo/commit/a2020a859d8d33e3ebf317419f2ae2839eb6685c)) - Mike, Claude Opus 5.5 (1M context)

- - -

## [v0.1.1](https://github.com/bitfloo/mailoo/compare/4fdb1ad0b46c4a20dbc81ec40d62f64afba14c73..v0.1.1) - 2026-09-22
#### ✨ Features
- (**config**) let an account name the folder sent mail is filed in - ([bfac8ca](https://github.com/bitfloo/mailoo/commit/bfac8cae245f62e2a2607d3817464abdb8880b54)) - Mike, Claude Opus 5.5 (1M context)
- add Jev System One inbound classify - ([86d5811](https://github.com/bitfloo/mailoo/commit/86d58119fde31ee6ad8d4c4c0c5035316f6233d9)) - Mike, Cursor
- close upstream email-mcp gaps in the Mailoo fork - ([0daadad](https://github.com/bitfloo/mailoo/commit/0daadadae1d46266013f6dceb228e30a93a7dc85)) - Mike, Cursor
- add Mailoo-local test-auditor and test-smith - ([32518b5](https://github.com/bitfloo/mailoo/commit/32518b5e9da329c7af836b7902afea26e778eaa1)) - Mike, Cursor
#### 🐛 Bug Fixes
- keep MCP release jq safe when server.json has no packages - ([ac0f2ff](https://github.com/bitfloo/mailoo/commit/ac0f2ff29482ac51b368d1dfb58abb4ce417c381)) - Mike, Cursor
- bind Mailoo test docs to the runner configs - ([99f0279](https://github.com/bitfloo/mailoo/commit/99f02797203e059335604a2d99381d17ad9a6fee)) - Mike, Cursor
#### 📚 Documentation
- put GreenMail SQL/Docker WHY back and bind include-unit - ([6d02b09](https://github.com/bitfloo/mailoo/commit/6d02b093ba0ce4868cc0bbf3bdf140d151026a4f)) - Mike, Cursor
- add Cursor Cloud agent roster and pnpm install - ([7428f07](https://github.com/bitfloo/mailoo/commit/7428f071cb14d4537e1cee2501d0c2bdec39b976)) - Mike, Cursor
- stop advertising unpublished npm in MCP metadata - ([68812a8](https://github.com/bitfloo/mailoo/commit/68812a882bcdfb526c2b37f48b15c67f4ccb1721)) - Mike, Cursor
- honest install path until npm and add OSS face agents - ([307ce6c](https://github.com/bitfloo/mailoo/commit/307ce6c5a3a71e577771727146ff0764395d94f5)) - Mike, Cursor
- name GreenMail as a test IMAP/SMTP server, not a database - ([8949a91](https://github.com/bitfloo/mailoo/commit/8949a916ba0d82eb699e6248102512ef755e0dc4)) - Mike, Cursor
- keep Mailoo test agents project-local and run integration in CI - ([1d3b9a1](https://github.com/bitfloo/mailoo/commit/1d3b9a1340d0c5e53679e089c4830a05be44cdbf)) - Mike, Cursor
- point MCP clients at a local clone until npm exists - ([9c2c142](https://github.com/bitfloo/mailoo/commit/9c2c142c3bc95a84c4560fa91b8255cd5044c9ef)) - Mike
- document Sent APPEND, Sieve, and related MCP surface - ([d39e116](https://github.com/bitfloo/mailoo/commit/d39e116906dae0bfb4cb80be53566f02731d69b2)) - Mike, Cursor
- stop promising unpublished npm install - ([4fdb1ad](https://github.com/bitfloo/mailoo/commit/4fdb1ad0b46c4a20dbc81ec40d62f64afba14c73)) - Mike, Cursor
#### Tests
- pin IMAP dates, security tool, and attachment oracles - ([cc01195](https://github.com/bitfloo/mailoo/commit/cc01195fb3b7f55acab3d0fddbc2ca85738f718a)) - Mike, Cursor
- assert applyBodyFormat maxLength truncation boundaries - ([af69327](https://github.com/bitfloo/mailoo/commit/af69327451ba9eb27b75324d7332d8df20e49428)) - Mike, Cursor
#### CI
- keep the GreenMail PR incident note and skip a dead Docker socket - ([ba602e7](https://github.com/bitfloo/mailoo/commit/ba602e7121c5f397ac8735c61b18afd96e6ae720)) - Mike, Cursor
- run the full suite on the laptop, not on every GitHub push - ([e97f7d4](https://github.com/bitfloo/mailoo/commit/e97f7d484634cbc10e3f6de27e30af7a6b1acd62)) - Mike, Cursor
#### ♻️ Refactoring
- split mail-arrival setup and share the server.json bump - ([cbb912f](https://github.com/bitfloo/mailoo/commit/cbb912f42960bff01414b33d7dcfb36c2579b50a)) - Mike, Cursor
- shrink sieve client and forwardEmail under length limits - ([fb38c6a](https://github.com/bitfloo/mailoo/commit/fb38c6a05f6e1632fad9f9c9dbbdb7a4d487946a)) - Mike, Cursor
#### Chores
- (**agents**) raise Mailoo test ship bar to auditor score ≥ 9 - ([efb0a52](https://github.com/bitfloo/mailoo/commit/efb0a52dbb8328562123b474c16376abc10f127b)) - Mike, Cursor
- (**agents**) Cursor grok tier and strengthen test-auditor contract - ([2f49086](https://github.com/bitfloo/mailoo/commit/2f490866a22121304983a00ae6196104a32b5302)) - Mike, Cursor
- adopt patch-only 0.1.x versioning - ([977c1b8](https://github.com/bitfloo/mailoo/commit/977c1b87460b377bb357e82ba43c10da29a74fc6)) - Mike, Cursor
- gate public GitHub commit messages and document versioning - ([404d07f](https://github.com/bitfloo/mailoo/commit/404d07f2c23670cfa2ef5b8f67e079c6c1ce0ecb)) - Mike, Cursor
- keep CBC session scratch out of the public tree - ([589c149](https://github.com/bitfloo/mailoo/commit/589c1490fefc917da642090effe9911ccd193b1a)) - Mike, Cursor
- fix CODEOWNERS for GitHub org login - ([4aaa479](https://github.com/bitfloo/mailoo/commit/4aaa47917e651a1e47eb9cd6801b303d5df2cea9)) - Mike, Cursor
#### Styles
- split ManageSieve tlsConnect options onto their own lines - ([0a97613](https://github.com/bitfloo/mailoo/commit/0a976134397e01db154844a8805d7e258873da63)) - Mike, Cursor
- break ManageSieve TLS callback to satisfy biome check - ([9da9067](https://github.com/bitfloo/mailoo/commit/9da9067cf383624afb021432ea86f1b11301354a)) - Mike, Cursor
- wrap ManageSieve TLS connect callback for Biome - ([612b3ff](https://github.com/bitfloo/mailoo/commit/612b3ffa6268e4900fabc34f65b3f313acde3b41)) - Mike, Cursor

- - -

## [v0.2.1](https://github.com/codefuturist/email-mcp/compare/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0..v0.2.1) - 2026-02-20
#### 🐛 Bug Fixes
- (**labels**) fix critical parameter swap and multiple label bugs - ([bd6f94d](https://github.com/codefuturist/email-mcp/commit/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0)) - Colin
- defer post-connect work until MCP handshake completes - ([7847da0](https://github.com/codefuturist/email-mcp/commit/7847da07b4241e73282b2a36a9dd1a362dfb8656)) - Colin
#### Tests
- (**integration**) expand plain connection tests to match STARTTLS and SSL coverage - ([8bd3d77](https://github.com/codefuturist/email-mcp/commit/8bd3d7752ca18037ca899899a1e14688b961c0b1)) - Colin
- (**integration**) add connection mode tests for plain, STARTTLS, and implicit SSL - ([ccbefb7](https://github.com/codefuturist/email-mcp/commit/ccbefb78248f0f08d31c5b227347f286f350c9f9)) - Colin
- (**integration**) add integration test suite with GreenMail and Testcontainers - ([1cc72fe](https://github.com/codefuturist/email-mcp/commit/1cc72fec8166842fa92ad8c7957c2ec28df327ac)) - Colin
#### Build
- (**docker**) add OCI manifest annotations for GHCR multi-arch images - ([2aeb938](https://github.com/codefuturist/email-mcp/commit/2aeb93857e95d99b2cf4435e4eee7cd7a47aecdc)) - Colin
- (**docker**) add docker and goreleaser scripts, fix build for dockers_v2 context - ([56102f4](https://github.com/codefuturist/email-mcp/commit/56102f42ce81bba8c9ab8f442926d1b9704d2ab4)) - Colin
- (**docker**) add GoReleaser dockers_v2 for GHCR and Docker Hub publishing - ([83483a8](https://github.com/codefuturist/email-mcp/commit/83483a8879228b3ec213414f2f7c53e9cce3f497)) - Colin
- (**docker**) add Dockerfile, docker-compose, and CI docker build - ([e9f0a9f](https://github.com/codefuturist/email-mcp/commit/e9f0a9f2179a59de064879456204c8c3b4f3945b)) - Colin
- add lefthook git hooks, report output, upgrade actions and node to v24 - ([8665419](https://github.com/codefuturist/email-mcp/commit/86654197b1a1f252d6c67d8a5fd67f09100f4fd4)) - Colin
#### CI
- (**docker**) enable docker hub publishing - ([f2a8d44](https://github.com/codefuturist/email-mcp/commit/f2a8d44fb8e503a0ef053a716e00b5814625daf8)) - Colin
- refactor workflows to use codefuturist/shared-workflows@v1 - ([815292c](https://github.com/codefuturist/email-mcp/commit/815292c91e6215592cd3172a91600cf42b2224e0)) - Colin
- add docker-sha workflow, workflow_dispatch, action upgrades and lint fixes - ([ddfbcdc](https://github.com/codefuturist/email-mcp/commit/ddfbcdc27af83175c3fec3c666ebd1f23d0631f4)) - Colin
- improve Docker tag strategy - ([99785a0](https://github.com/codefuturist/email-mcp/commit/99785a0ea5c01579046783c3fdf7347932e77fdb)) - Colin
- add weekly Docker rebuild workflow for base image updates - ([08f77f9](https://github.com/codefuturist/email-mcp/commit/08f77f9d06c8fd5b6de65a08c9ff89b556e7f2c0)) - Colin
#### Chores
- (**eslint**) exclude integration tests from eslint - ([e3bcc12](https://github.com/codefuturist/email-mcp/commit/e3bcc122bb9d71bfdfd77040d4419b96296a162d)) - Colin
- (**gitignore**) update .gitignore to include comprehensive rules for various environments and tools - ([4c55dea](https://github.com/codefuturist/email-mcp/commit/4c55dea709e592f3e9f8b01d449846742774c07f)) - Colin
- fix changelog separator for cocogitto - ([55510c3](https://github.com/codefuturist/email-mcp/commit/55510c34bb44ac377e91e1c628d7a810ed2e6d6e)) - Colin

- - -


## [v0.1.0](https://github.com/codefuturist/email-mcp/releases/tag/v0.1.0) — Initial Release

First public release of email-mcp.

#### ✨ Features

- Full IMAP + SMTP email server for MCP clients
- 42 tools, 7 prompts, 6 resources
- Multi-account support with XDG-compliant TOML config
- Guided interactive setup wizard with provider auto-detection
- Gmail, Outlook, Yahoo, iCloud, Fastmail, ProtonMail, Zoho, GMX support
- OAuth2 XOAUTH2 for Gmail and Microsoft 365 _(experimental)_
- Email scheduling with OS-level scheduler integration
- Real-time IMAP IDLE watcher with AI-powered triage
- Urgency-based desktop / webhook alerts
- Provider-aware label management
- ICS/iCalendar extraction from emails
- Email analytics (volume, top senders, daily trends)
- Token-bucket rate limiter and audit trail
- MCP client auto-installer (Claude Desktop, VS Code, Cursor, Windsurf)
