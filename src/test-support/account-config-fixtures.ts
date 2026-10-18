/**
 * Config files the account CLI suite writes before it runs a command, each in
 * the shape a user's file has. Accounts use reserved example domains.
 */

/** Real shape: one account, then a table header the user left unclosed. */
export const CONFIG_WITH_SYNTAX_ERROR = `[[accounts]]
name = "personal"
email = "me@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp
host = "smtp.example.com"
`;

/** Real shape: one account and a [settings] table with one value set by hand. */
export const CONFIG_WITH_PERSONAL = `[settings]
rate_limit = 3

[[accounts]]
name = "personal"
email = "me@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

/** Real shape: a second account appended after the first. */
export const CONFIG_WITH_PERSONAL_AND_WORK = `${CONFIG_WITH_PERSONAL}
[[accounts]]
name = "work"
email = "work@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

/** Parses as TOML, fails the schema: the account email is not an address. */
export const CONFIG_FAILING_SCHEMA = CONFIG_WITH_PERSONAL.replace('me@example.com', 'nope');
