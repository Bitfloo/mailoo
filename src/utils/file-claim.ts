/**
 * Cross-process claims on a lock file.
 *
 * Exclusive create (`wx`) is the only claim. A holder that works longer than
 * the stale window refreshes the lock's mtime; a lock whose mtime is older
 * than that window belonged to a dead holder and may be taken. Release deletes
 * the lock only while it still holds this holder's token.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

async function createClaim(lockPath: string, token: string): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, token, { flag: 'wx' });
    return true;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw err;
  }
}

/** One boundary for both reads, so the first check and the re-check after parking agree. */
function claimIsStale(age: number, staleMs: number): boolean {
  return age > staleMs;
}

async function claimAge(lockPath: string, now: number): Promise<number | undefined> {
  try {
    const stat = await fs.stat(lockPath);
    return now - stat.mtimeMs;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

async function stealStaleClaim(
  lockPath: string,
  staleMs: number,
  now: number,
  token: string,
): Promise<boolean> {
  const parked = `${lockPath}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, parked);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
  try {
    const age = await claimAge(parked, now);
    if (age === undefined || !claimIsStale(age, staleMs)) {
      try {
        // rename would replace a claim created after the park.
        await fs.link(parked, lockPath);
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST') throw err;
      }
      return false;
    }
    return await createClaim(lockPath, token);
  } finally {
    await fs.unlink(parked).catch(() => undefined);
  }
}

/** The holder's token, or undefined while a live holder has the lock. */
export async function acquireClaim(
  lockPath: string,
  staleMs: number,
  now = Date.now(),
): Promise<string | undefined> {
  const token = crypto.randomUUID();
  if (await createClaim(lockPath, token)) return token;
  const age = await claimAge(lockPath, now);
  if (age === undefined) {
    return (await createClaim(lockPath, token)) ? token : undefined;
  }
  if (!claimIsStale(age, staleMs)) return undefined;
  return (await stealStaleClaim(lockPath, staleMs, now, token)) ? token : undefined;
}

export function startClaimRenewal(lockPath: string, everyMs: number): () => void {
  const timer = setInterval(() => {
    fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
  }, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

export async function releaseClaim(lockPath: string, token: string): Promise<void> {
  try {
    const current = await fs.readFile(lockPath, 'utf8');
    if (current !== token) return;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return;
    throw err;
  }
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
  }
}
