/**
 * Reusable MCP tool parameter schemas, normalizers, and structured output helpers.
 *
 * Designed for compatibility across both small local LLMs (3B–8B with llama.cpp
 * GBNF grammars — zero regex lookaheads) and frontier models.
 */

import { z } from 'zod';

/**
 * Optional account parameter. When omitted, ConnectionManager resolves
 * `defaultAccount` (`MCP_EMAIL_DEFAULT_ACCOUNT` / `default_account`) or falls
 * back to the sole configured account when `accounts.length === 1`.
 */
export const accountParam = z
  .string()
  .optional()
  .describe(
    'Account name or email from list_accounts (optional when only one account or a default account is configured)',
  );

/** Single email ID value accepting either string or integer UID. */
export const emailIdValueSchema = z.union([z.string(), z.number().int()]);

/**
 * Input schema fields for tools operating on a single email message.
 * Accepts canonical `emailId` as well as aliases `id` and `email_id`.
 */
export function emailIdInputFields(
  primaryDescription = 'Email ID from list_emails or search_emails',
): {
  emailId: z.ZodOptional<typeof emailIdValueSchema>;
  id: z.ZodOptional<typeof emailIdValueSchema>;
  email_id: z.ZodOptional<typeof emailIdValueSchema>;
} {
  return {
    emailId: emailIdValueSchema.optional().describe(primaryDescription),
    id: emailIdValueSchema.optional().describe('Alias of emailId'),
    email_id: emailIdValueSchema.optional().describe('Alias of emailId'),
  };
}

/**
 * Resolve a single email ID from `{ emailId, id, email_id }`, coercing numbers
 * to trimmed strings. Throws a clear error if none was provided.
 */
export function resolveEmailId(params: {
  emailId?: string | number;
  id?: string | number;
  email_id?: string | number;
}): string {
  const raw = params.emailId ?? params.id ?? params.email_id;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('Email ID is required (provide emailId, id, or email_id)');
  }
  return String(raw).trim();
}

/** Draft UID value accepting either an integer or a numeric string. */
export const draftIdValueSchema = z.union([z.number().int(), z.string()]);

/**
 * Input schema fields for `send_draft`, accepting `id`, `emailId`, or `email_id`
 * as either a number or numeric string.
 */
export function draftIdInputFields(
  primaryDescription = 'Email ID (UID) of the draft in the Drafts folder',
): {
  id: z.ZodOptional<typeof draftIdValueSchema>;
  emailId: z.ZodOptional<typeof draftIdValueSchema>;
  email_id: z.ZodOptional<typeof draftIdValueSchema>;
} {
  return {
    id: draftIdValueSchema.optional().describe(primaryDescription),
    emailId: draftIdValueSchema.optional().describe('Alias of id for the draft UID'),
    email_id: draftIdValueSchema.optional().describe('Alias of id for the draft UID'),
  };
}

/**
 * Resolve a draft UID from `{ id, emailId, email_id }`, coercing string numbers
 * (`"42"` -> `42`).
 */
export function resolveDraftId(params: {
  id?: number | string;
  emailId?: number | string;
  email_id?: number | string;
}): number {
  const raw = params.id ?? params.emailId ?? params.email_id;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('Draft ID is required (provide id, emailId, or email_id)');
  }
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error('Draft ID must be a positive integer UID');
  }
  return num;
}

/**
 * Array of message IDs accepting both string UIDs (`["42"]`) and integer UIDs (`[42]`).
 */
export function idArraySchema(
  maxItems: number,
  description: string,
): z.ZodArray<typeof emailIdValueSchema> {
  return z.array(emailIdValueSchema).min(1).max(maxItems).describe(description);
}

/** Normalize an array of string/number IDs to trimmed strings. */
export function normalizeStringIds(ids: (string | number)[]): string[] {
  return ids.map((id) => String(id).trim());
}

/** Normalize an array of string/number IDs to positive integer UIDs. */
export function normalizeNumericIds(ids: (string | number)[]): number[] {
  return ids.map((id) => {
    const num = typeof id === 'number' ? id : Number(String(id).trim());
    if (!Number.isInteger(num) || num <= 0) {
      throw new Error(`Invalid email ID "${id}": must be a positive integer UID`);
    }
    return num;
  });
}

/**
 * Attachment filter fields supporting both camelCase `hasAttachment` and
 * snake_case `has_attachment`.
 */
export const attachmentFilterFields = {
  hasAttachment: z
    .boolean()
    .optional()
    .describe('Filter: true=has attachments, false=no attachments'),
  has_attachment: z
    .boolean()
    .optional()
    .describe('Alias of hasAttachment (filter: true=has attachments, false=no attachments)'),
};

/** Resolve `hasAttachment` from either `hasAttachment` or `has_attachment`. */
export function resolveHasAttachment(params: {
  hasAttachment?: boolean;
  has_attachment?: boolean;
}): boolean | undefined {
  return params.hasAttachment ?? params.has_attachment;
}

/** Reusable `dryRun` parameter for high-risk write/delete operations. */
export const dryRunParam = z
  .boolean()
  .default(false)
  .describe('Validate parameters and preview the effect without executing the action');

/**
 * Standard MCP `outputSchema` shape for Mailoo tools.
 */
export const standardToolOutputSchema = {
  ok: z.boolean().describe('Whether the tool operation succeeded'),
  summary: z.string().describe('Human-readable summary or result text'),
  dryRun: z.boolean().optional().describe('True when executed in dry-run preview mode'),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Structured payload for programmatic consumption'),
};

/**
 * Build a tool result containing both `content` (text) and `structuredContent`
 * conforming to `standardToolOutputSchema`.
 */
export function structuredToolResult(
  text: string,
  data?: Record<string, unknown>,
  dryRun?: boolean,
): {
  content: { type: 'text'; text: string }[];
  structuredContent: {
    ok: boolean;
    summary: string;
    dryRun?: boolean;
    data?: Record<string, unknown>;
  };
} {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      ok: true,
      summary: text,
      ...(dryRun !== undefined ? { dryRun } : {}),
      ...(data !== undefined ? { data } : {}),
    },
  };
}
