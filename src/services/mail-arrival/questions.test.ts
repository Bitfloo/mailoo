import type { NoulQuestion } from '@typesafe-ai/sdk';
import { buildQuestionMap, slugFolderId } from './questions.js';

function noulQuestion(q: unknown): NoulQuestion | undefined {
  if (typeof q === 'object' && q !== null && (q as { type?: string }).type === 'noul') {
    return q as NoulQuestion;
  }
  return undefined;
}

describe('slugFolderId', () => {
  it('slugs Receipts and INBOX.Receipts', () => {
    expect(slugFolderId('Receipts')).toBe('receipts');
    expect(slugFolderId('INBOX.Receipts')).toBe('inbox_receipts');
  });

  it('collides Foo Bar with foo_bar', () => {
    expect(slugFolderId('Foo Bar')).toBe('foo_bar');
    expect(slugFolderId('foo_bar')).toBe('foo_bar');
  });
});

describe('buildQuestionMap', () => {
  it('synthesizes criteria.false from sibling paths not descriptions', () => {
    const questions = buildQuestionMap([
      {
        id: 'receipts',
        path: 'Receipts',
        description: 'Invoices, receipts, and payment confirmations.',
      },
      {
        id: 'archive',
        path: 'Archive',
        description: 'Settled correspondence that needs no further action.',
      },
      {
        id: 'newsletters',
        path: 'Newsletters',
        description: 'Subscriptions and bulk updates the operator chose to keep.',
      },
    ]);

    const receipts = noulQuestion(questions.folder_fit_receipts);
    expect(receipts?.type).toBe('noul');
    expect(receipts?.criteria?.false).toBe(
      'Belongs in Archive, Newsletters, or in none of the configured folders.',
    );
    expect(JSON.stringify(receipts)).not.toContain('Settled correspondence');

    const archive = noulQuestion(questions.folder_fit_archive);
    expect(archive?.criteria?.true).toBe('Settled correspondence that needs no further action.');
  });

  it('uses operator falseCriteria when provided', () => {
    const questions = buildQuestionMap([
      {
        id: 'archive',
        path: 'Archive',
        description: 'Settled correspondence that needs no further action.',
        falseCriteria: 'Still needs a reply, or belongs in Receipts or Newsletters.',
      },
    ]);
    const archive = noulQuestion(questions.folder_fit_archive);
    expect(archive?.criteria?.false).toBe(
      'Still needs a reply, or belongs in Receipts or Newsletters.',
    );
  });

  it('uses the no-sibling false string when folders has one row', () => {
    const questions = buildQuestionMap([
      { id: 'receipts', path: 'Receipts', description: 'Invoices.' },
    ]);
    const receipts = noulQuestion(questions.folder_fit_receipts);
    expect(receipts?.criteria?.false).toBe(
      "Does not match this folder's purpose, or belongs in none of the configured folders.",
    );
  });

  it('should emit only noul+score keys when folders are configured', () => {
    const folders = [
      {
        id: 'receipts',
        path: 'Receipts',
        description: 'Invoices, receipts, and payment confirmations.',
      },
      {
        id: 'archive',
        path: 'Archive',
        description: 'Settled correspondence that needs no further action.',
      },
    ];
    const questions = buildQuestionMap(folders);
    const securityNouls = [
      'contains_prompt_injection',
      'requests_credentials',
      'offers_unexpected_reward',
      'creates_time_pressure',
      'sender_identity_mismatch',
      'link_domain_mismatch',
      'disguises_link_destination',
      'is_critical',
    ] as const;

    securityNouls.forEach((id) => {
      expect(questions[id]?.type).toBe('noul');
    });
    expect(questions.importance?.type).toBe('score');

    const folderFitKeys = Object.keys(questions).filter((key) => key.startsWith('folder_fit_'));
    expect(folderFitKeys).toEqual(['folder_fit_receipts', 'folder_fit_archive']);
    folderFitKeys.forEach((key) => {
      expect(questions[key]?.type).toBe('noul');
    });

    Object.values(questions).forEach((question) => {
      expect(question.type).not.toBe('choice');
      expect(['noul', 'score']).toContain(question.type);
    });
  });
});
