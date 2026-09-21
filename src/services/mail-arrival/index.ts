/**
 * MailArrival facade: one System One call per classified message, then IMAP apply.
 */

import type { EntryType, Questions } from '@typesafe-ai/sdk';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { mcpLog } from '../../logging.js';
import audit from '../../safety/audit.js';
import type { AccountConfig, SystemOneConfig } from '../../types/index.js';
import type { SenderAuthSignals } from '../../utils/auth-headers.js';
import type ImapService from '../imap.service.js';
import { buildFolderSpecs, probeAccountFolders } from './folders.js';
import type { FolderSpec, MailAction, MailAnswers } from './policy.js';
import { composeSpamRisk, decideMailAction } from './policy.js';
import { buildQuestionMap } from './questions.js';
import type { ArrivalEmail, MailState } from './state.js';
import { buildMailState } from './state.js';

export type { MailAction, MailNoopReason } from './policy.js';
export { decideMailAction } from './policy.js';
export type { ArrivalEmail } from './state.js';

function noulValue(answers: Record<string, unknown>, id: string): number | undefined {
  const raw = answers[id];
  if (typeof raw !== 'object' || raw === null || !('noul' in raw)) return undefined;
  const value = (raw as { noul: unknown }).noul;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scoreValue(
  answers: Record<string, unknown>,
  id: string,
): { score: number; confidence: number } | undefined {
  const raw = answers[id];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as { score?: unknown; confidence?: unknown };
  if (typeof rec.score !== 'number' || typeof rec.confidence !== 'number') return undefined;
  if (!Number.isFinite(rec.score) || !Number.isFinite(rec.confidence)) return undefined;
  return { score: rec.score, confidence: rec.confidence };
}

function mapAnswers(
  raw: Record<string, unknown>,
  folders: readonly FolderSpec[],
): MailAnswers | null {
  const injection = noulValue(raw, 'contains_prompt_injection');
  const credentials = noulValue(raw, 'requests_credentials');
  const reward = noulValue(raw, 'offers_unexpected_reward');
  const mismatch = noulValue(raw, 'sender_identity_mismatch');
  const critical = noulValue(raw, 'is_critical');
  const importance = scoreValue(raw, 'importance');
  if (
    injection === undefined ||
    credentials === undefined ||
    reward === undefined ||
    mismatch === undefined ||
    critical === undefined ||
    importance === undefined
  ) {
    return null;
  }

  const folderFit = new Map<string, number>();
  folders.forEach((folder) => {
    const noul = noulValue(raw, `folder_fit_${folder.id}`);
    if (noul !== undefined) folderFit.set(folder.id, noul);
  });

  return {
    contains_prompt_injection: injection,
    requests_credentials: credentials,
    offers_unexpected_reward: reward,
    sender_identity_mismatch: mismatch,
    folder_fit: folderFit,
    importance,
    is_critical: critical,
  };
}

async function classify(
  client: TypeSafeClient,
  state: MailState,
  questions: Questions,
  model: string,
  folders: readonly FolderSpec[],
): Promise<MailAnswers | null> {
  try {
    const result = await client.systemOne({
      state: state as unknown as EntryType,
      questions,
      model,
    });
    const raw = result.answers as Record<string, unknown>;
    if (!raw || Object.keys(raw).length === 0) return null;
    return mapAnswers(raw, folders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await mcpLog('warning', 'mail-arrival', `systemOne failed: ${msg}`);
    return null;
  }
}

function seenKey(email: ArrivalEmail): string {
  if (email.meta.messageId) return `mid:${email.meta.messageId}`;
  return `uid:${email.account}:${email.mailbox}:${email.meta.id}`;
}

async function applyMailAction(
  imap: ImapService,
  email: ArrivalEmail,
  action: MailAction,
): Promise<void> {
  if (action.kind === 'noop') return;
  if (action.flag) {
    try {
      await imap.setFlags(email.account, email.meta.id, email.mailbox, 'flag');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'mail-arrival', `Could not flag email ${email.meta.id}: ${msg}`);
    }
  }
  if (action.destinationMailbox) {
    try {
      await imap.moveEmail(email.account, email.meta.id, email.mailbox, action.destinationMailbox);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mcpLog(
        'warning',
        'mail-arrival',
        `Could not move email ${email.meta.id} to ${action.destinationMailbox}: ${msg}`,
      );
    }
  }
  try {
    await audit.log(
      'mail_arrival',
      email.account,
      {
        uid: email.meta.id,
        mailbox: email.mailbox,
        destination: action.destinationMailbox,
        flag: action.flag,
      },
      'ok',
    );
  } catch {
    // Audit must not block filing.
  }
}

export class MailArrival {
  private readonly seen = new Set<string>();

  private constructor(
    private readonly client: TypeSafeClient,
    private readonly imap: ImapService,
    private readonly config: SystemOneConfig,
    private readonly foldersByAccount: ReadonlyMap<string, FolderSpec[]>,
  ) {}

  static async tryCreate(opts: {
    config: SystemOneConfig;
    imap: ImapService;
    apiKey: string | undefined;
    accounts: readonly AccountConfig[];
    moveToPaths?: readonly string[];
  }): Promise<MailArrival | null> {
    const { config, imap, accounts } = opts;
    const apiKey = opts.apiKey?.trim();
    if (!config.enabled || !apiKey) return null;

    const folderSpecs = await buildFolderSpecs(config.folders);
    if (!folderSpecs) return null;
    if (folderSpecs.length === 0) {
      await mcpLog(
        'warning',
        'mail-arrival',
        'system_one: folders[] is empty — classify/flag only; no MOVE',
      );
    }

    const client = new TypeSafeClient({ apiKey, logLevel: 'error' });
    const foldersByAccount = await probeAccountFolders(
      imap,
      accounts,
      folderSpecs,
      opts.moveToPaths ?? [],
    );
    return new MailArrival(client, imap, config, foldersByAccount);
  }

  async handle(email: ArrivalEmail): Promise<MailAction> {
    const key = seenKey(email);
    if (this.seen.has(key)) {
      return { kind: 'noop', reason: 'already_seen' };
    }

    if (!this.config.sourceFolders.includes(email.mailbox)) {
      return { kind: 'noop', reason: 'not_in_source' };
    }

    this.seen.add(key);

    const folders = this.foldersByAccount.get(email.account) ?? [];
    let security: SenderAuthSignals;
    try {
      security = await this.imap.getEmailSecurity(email.account, email.meta.id, email.mailbox);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'mail-arrival', `getEmailSecurity failed: ${msg}`);
      return { kind: 'noop', reason: 'api_error' };
    }

    let bodyText = '';
    if (this.config.includeBody) {
      try {
        bodyText = await this.imap.peekText(email.account, email.meta.id, email.mailbox);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await mcpLog('warning', 'mail-arrival', `peekText failed: ${msg}`);
      }
    }

    let attachmentNames: readonly { filename: string; mime: string }[] = [];
    try {
      attachmentNames = await this.imap.peekAttachments(
        email.account,
        email.meta.id,
        email.mailbox,
      );
    } catch {
      attachmentNames = [];
    }

    const state = buildMailState({
      email,
      security,
      bodyText,
      attachmentNames,
      includeBody: this.config.includeBody,
      bodyMaxChars: this.config.bodyMaxChars,
    });

    const questions = buildQuestionMap(folders);
    const mapped = await classify(this.client, state, questions, this.config.model, folders);
    if (!mapped) {
      return { kind: 'noop', reason: 'api_error' };
    }

    const spam = composeSpamRisk(mapped);
    if (spam >= this.config.thresholds.spamHigh) {
      await mcpLog(
        'warning',
        'mail-arrival',
        `spam_high account=${email.account} uid=${email.meta.id} mailbox=${email.mailbox}`,
      );
    }

    const { thresholds } = this.config;
    const action = decideMailAction(mapped, {
      folders,
      autoMove: this.config.autoMove,
      autoFlag: this.config.autoFlag,
      thresholds: {
        folderFitMin: thresholds.folderFitMin,
        spamUncertainLow: thresholds.spamUncertainLow,
        spamUncertainHigh: thresholds.spamUncertainHigh,
        injectionHigh: thresholds.injectionHigh,
        importanceFlagMin: thresholds.importanceFlagMin,
        importanceMinConfidence: thresholds.importanceMinConfidence,
        isCriticalMin: thresholds.isCriticalMin,
      },
    });
    await applyMailAction(this.imap, email, action);
    return action;
  }
}
