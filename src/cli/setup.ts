/**
 * Interactive setup wizard for mailoo.
 *
 * Legacy entry point — delegates to `account add`.
 */

import runAccountCommand from './account-commands.js';

/**
 * Run the setup wizard.
 *
 * @deprecated Use `mailoo account add` instead. This alias is kept for backwards-compatibility.
 */
export default async function runSetup(): Promise<void> {
  await runAccountCommand('add');
}
