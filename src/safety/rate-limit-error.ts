/** Raised before anything reaches SMTP, so a caller can retry later without counting an attempt. */
export default class RateLimitError extends Error {
  constructor(accountName: string) {
    super(
      `Rate limit exceeded for account "${accountName}". ` +
        `Please wait before sending more emails.`,
    );
    this.name = 'RateLimitError';
  }
}
