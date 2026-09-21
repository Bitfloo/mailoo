/**
 * Pure System One policy: compose spam risk in code, then decide MOVE / flag / stay.
 */

export type MailNoopReason =
  | 'disabled'
  | 'no_api_key'
  | 'read_only'
  | 'static_skip'
  | 'already_seen'
  | 'api_error'
  | 'no_folder_fit'
  | 'injection_filter'
  | 'spam_uncertain'
  | 'invalid_folder'
  | 'not_in_source'
  | 'auto_move_off';

/** Product, not XOR: flag then MOVE on the same UID in the source mailbox. */
export type MailAction =
  | { kind: 'noop'; reason: MailNoopReason }
  | {
      kind: 'apply';
      destinationMailbox?: string;
      flag: boolean;
    };

export interface FolderSpec {
  id: string;
  path: string;
  description: string;
  falseCriteria?: string;
  priority?: number;
}

export interface MailAnswers {
  contains_prompt_injection: number;
  requests_credentials: number;
  offers_unexpected_reward: number;
  sender_identity_mismatch: number;
  folder_fit: ReadonlyMap<string, number>;
  importance: { score: number; confidence: number };
  is_critical: number;
}

export interface PolicyConfig {
  folders: readonly FolderSpec[];
  autoMove: boolean;
  autoFlag: boolean;
  thresholds: {
    folderFitMin: number;
    spamUncertainLow: number;
    spamUncertainHigh: number;
    injectionHigh: number;
    importanceFlagMin: number;
    importanceMinConfidence: number;
    isCriticalMin: number;
  };
}

const CREDENTIALS_WEIGHT = 0.45;
const MISMATCH_WEIGHT = 0.3;
const REWARD_WEIGHT = 0.25;
const INJECTION_UNCERTAIN_WIDTH = 0.1;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function composeSpamRisk(a: MailAnswers): number {
  return clamp01(
    CREDENTIALS_WEIGHT * a.requests_credentials +
      MISMATCH_WEIGHT * a.sender_identity_mismatch +
      REWARD_WEIGHT * a.offers_unexpected_reward,
  );
}

function shouldFlag(answers: MailAnswers, config: PolicyConfig): boolean {
  if (!config.autoFlag) return false;
  const { thresholds } = config;
  if (answers.is_critical >= thresholds.isCriticalMin) return true;
  return (
    answers.importance.score >= thresholds.importanceFlagMin &&
    answers.importance.confidence >= thresholds.importanceMinConfidence
  );
}

function pickDestination(answers: MailAnswers, config: PolicyConfig): string | undefined {
  if (!config.autoMove) return undefined;
  let best: { path: string; noul: number; priority: number; index: number } | undefined;
  config.folders.forEach((folder, index) => {
    const noul = answers.folder_fit.get(folder.id);
    if (noul === undefined || noul < config.thresholds.folderFitMin) return;
    const priority = folder.priority ?? index;
    if (
      !best ||
      noul > best.noul ||
      (noul === best.noul &&
        (priority < best.priority || (priority === best.priority && index < best.index)))
    ) {
      best = { path: folder.path, noul, priority, index };
    }
  });
  return best?.path;
}

export function decideMailAction(answers: MailAnswers, config: PolicyConfig): MailAction {
  const injection = answers.contains_prompt_injection;
  if (
    injection >= config.thresholds.injectionHigh ||
    Math.abs(injection - 0.5) < INJECTION_UNCERTAIN_WIDTH
  ) {
    return { kind: 'noop', reason: 'injection_filter' };
  }

  const spam = composeSpamRisk(answers);
  if (spam > config.thresholds.spamUncertainLow && spam < config.thresholds.spamUncertainHigh) {
    return { kind: 'noop', reason: 'spam_uncertain' };
  }

  const flag = shouldFlag(answers, config);
  const destinationMailbox = pickDestination(answers, config);

  if (destinationMailbox) {
    return { kind: 'apply', destinationMailbox, flag };
  }
  if (flag) {
    return { kind: 'apply', flag: true };
  }
  if (config.autoMove) {
    return { kind: 'noop', reason: 'no_folder_fit' };
  }
  return { kind: 'noop', reason: 'auto_move_off' };
}
