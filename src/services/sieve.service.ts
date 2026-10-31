/**
 * ManageSieve (RFC 5804) client — list/get/put/delete/activate scripts.
 */

import type { Socket } from 'node:net';
import { connect as netConnect } from 'node:net';
import { TLSSocket, connect as tlsConnect } from 'node:tls';

import { redactedError } from '../connections/credential-redaction.js';
import type { AccountConfig } from '../types/index.js';

/* eslint-disable no-param-reassign -- ManageSieve reader mutates the connection buffer */

export interface SieveScriptInfo {
  name: string;
  active: boolean;
}

export interface SieveStatus {
  available: boolean;
  host: string;
  port: number;
  warning?: string;
  implementation?: string;
  sieveExtensions?: string[];
  scripts?: SieveScriptInfo[];
}

interface SieveConn {
  socket: Socket;
  buf: Buffer;
  lastCaps: Record<string, string>;
  lastLiteral?: string;
}

interface ResponseBudget {
  bytes: number;
  error?: Error;
  rejectWait?: (err: Error) => void;
}

export function parseListScripts(lines: string[]): SieveScriptInfo[] {
  return lines
    .map((line) => {
      const match = /^"((?:\\.|[^"\\])*)"(\s+ACTIVE)?\s*$/i.exec(line.trim());
      if (!match) return null;
      return { name: match[1].replace(/\\([\\"])/g, '$1'), active: Boolean(match[2]) };
    })
    .filter((s): s is SieveScriptInfo => s !== null);
}

export function encodePlainAuth(user: string, pass: string): string {
  return Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
}

export function parseCapabilityMap(lines: string[]): Record<string, string> {
  const caps: Record<string, string> = {};
  lines.forEach((line) => {
    const match = /^"([^"]+)"(?:\s+"([^"]*)")?/.exec(line.trim());
    if (match) caps[match[1].toUpperCase()] = match[2] ?? '';
  });
  return caps;
}

function quoteSieve(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Script literal cap for uploads and server responses; oversized uploads never open a socket. */
export const MAX_SIEVE_SCRIPT_BYTES = 1024 * 1024;

/** One maximum-size script plus 64 KiB for framing, capabilities and status lines. */
export const MAX_SIEVE_RESPONSE_BYTES = MAX_SIEVE_SCRIPT_BYTES + 64 * 1024;

/** Absolute deadlines prevent a busy peer from holding an operation open indefinitely. */
export const SIEVE_RESPONSE_TIMEOUT_MS = 30_000;
export const SIEVE_TLS_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * RFC 5804 §1.6: servers must accept names up to 128 characters and may accept
 * longer. 255 is a chosen client-side ceiling above that floor so an oversized
 * name is refused before a connection is opened. A server at the minimum
 * refuses 129-255 itself.
 */
const MAX_SIEVE_SCRIPT_NAME_CHARS = 255;

function assertSieveScriptName(name: string, allowEmpty = false): void {
  if (allowEmpty && name.length === 0) return;
  if (name.length === 0) {
    throw new Error('Script name must not be empty');
  }
  if (name.length > MAX_SIEVE_SCRIPT_NAME_CHARS) {
    throw new Error('Script name is too long');
  }
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in script names
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(name)) {
    throw new Error('Script name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
}

function assertSieveScriptContent(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SIEVE_SCRIPT_BYTES) {
    throw new Error(`Script is too large (maximum ${MAX_SIEVE_SCRIPT_BYTES} bytes)`);
  }
}

function bindSocketWait(
  conn: SieveConn,
  budget: ResponseBudget,
  tryConsume: () => boolean,
  reject: (err: Error) => void,
): void {
  /* eslint-disable @typescript-eslint/no-use-before-define -- finish and the listeners close over each other */
  function finish(): void {
    conn.socket.off('data', onData);
    conn.socket.off('error', onError);
    conn.socket.off('end', onEnd);
    conn.socket.off('close', onEnd);
    budget.rejectWait = undefined;
  }
  function onData(chunk: Buffer): void {
    budget.bytes += chunk.length;
    if (budget.bytes > MAX_SIEVE_RESPONSE_BYTES) {
      onError(new Error(`ManageSieve response exceeds ${MAX_SIEVE_RESPONSE_BYTES} bytes`));
      conn.socket.destroy();
      return;
    }
    conn.buf = Buffer.concat([conn.buf, chunk]);
    if (tryConsume()) finish();
  }
  function onError(err: Error): void {
    finish();
    reject(err);
  }
  function onEnd(): void {
    finish();
    reject(new Error('ManageSieve connection closed before the response completed'));
  }
  /* eslint-enable @typescript-eslint/no-use-before-define */
  conn.socket.on('data', onData);
  conn.socket.once('error', onError);
  conn.socket.once('end', onEnd);
  conn.socket.once('close', onEnd);
  budget.rejectWait = onError;
  if (conn.socket.destroyed || conn.socket.readableEnded) onEnd();
}

async function readLine(conn: SieveConn, budget: ResponseBudget): Promise<string> {
  if (budget.error) throw budget.error;
  return new Promise((resolve, reject) => {
    const tryConsume = (): boolean => {
      const idx = conn.buf.indexOf(10);
      if (idx < 0) return false;
      const line = conn.buf.subarray(0, idx).toString('utf8').replace(/\r$/, '');
      conn.buf = conn.buf.subarray(idx + 1);
      resolve(line);
      return true;
    };
    if (tryConsume()) return;
    bindSocketWait(conn, budget, tryConsume, reject);
  });
}

async function readBytes(conn: SieveConn, n: number, budget: ResponseBudget): Promise<string> {
  if (budget.error) throw budget.error;
  return new Promise((resolve, reject) => {
    const tryConsume = (): boolean => {
      if (conn.buf.length < n) return false;
      const payload = conn.buf.subarray(0, n).toString('utf8');
      conn.buf = conn.buf.subarray(n);
      resolve(payload);
      return true;
    };
    if (tryConsume()) return;
    bindSocketWait(conn, budget, tryConsume, reject);
  });
}

async function readResponse(
  conn: SieveConn,
): Promise<{ code: string; lines: string[]; message: string }> {
  const lines: string[] = [];
  const budget: ResponseBudget = { bytes: conn.buf.length };
  if (budget.bytes > MAX_SIEVE_RESPONSE_BYTES) {
    throw new Error(`ManageSieve response exceeds ${MAX_SIEVE_RESPONSE_BYTES} bytes`);
  }
  const timer = setTimeout(() => {
    const error = new Error('ManageSieve response timeout');
    budget.error = error;
    budget.rejectWait?.(error);
    conn.socket.destroy();
  }, SIEVE_RESPONSE_TIMEOUT_MS);
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- protocol lines and literals must be consumed in order
      const line = await readLine(conn, budget);
      if (/^(OK|NO|BYE)(?:\s|$)/i.test(line)) {
        return { code: line.slice(0, 2).toUpperCase(), lines, message: line };
      }
      if (line.startsWith('{')) {
        const lit = /^\{(\d+)\+?\}\s*$/.exec(line);
        if (lit) {
          const length = Number(lit[1]);
          if (!Number.isSafeInteger(length) || length > MAX_SIEVE_SCRIPT_BYTES) {
            throw new Error(
              `ManageSieve literal exceeds ${MAX_SIEVE_SCRIPT_BYTES} bytes or has an invalid length`,
            );
          }
          // eslint-disable-next-line no-await-in-loop -- the literal follows its length declaration
          const payload = await readBytes(conn, length, budget);
          lines.push(payload);
          // eslint-disable-next-line no-await-in-loop -- consume the literal's trailing CRLF
          await readLine(conn, budget);
        } else {
          lines.push(line);
        }
      } else {
        lines.push(line);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function extractLiteral(lines: string[]): string | undefined {
  const last = lines[lines.length - 1];
  if (last && !last.startsWith('"') && last.includes('\n')) return last;
  if (lines.length === 1 && !lines[0].startsWith('"')) return lines[0];
  if (lines.length > 0 && !lines[0].startsWith('"')) return lines.join('\n');
  return undefined;
}

async function sendCommand(
  conn: SieveConn,
  command: string,
): Promise<{ code: string; lines: string[]; message: string }> {
  conn.socket.write(`${command}\r\n`);
  const resp = await readResponse(conn);
  const lastLiteral = extractLiteral(resp.lines);
  if (lastLiteral !== undefined) conn.lastLiteral = lastLiteral;
  return resp;
}

function assertOk(resp: { code: string; message: string }, command: string): void {
  if (resp.code !== 'OK') {
    throw new Error(`${command} failed: ${resp.message}`);
  }
}

async function connectTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    /* eslint-disable @typescript-eslint/no-use-before-define -- connection listeners share cleanup */
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`ManageSieve connect timed out (${host}:${port})`));
    }, timeoutMs);
    function onConnect(): void {
      cleanup();
      resolve(socket);
    }
    function onError(err: Error): void {
      cleanup();
      reject(err);
    }
    /* eslint-enable @typescript-eslint/no-use-before-define */
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

async function upgradeTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    /* eslint-disable @typescript-eslint/no-use-before-define -- handshake listeners share cleanup */
    const cleanup = (): void => {
      clearTimeout(timer);
      tlsSock.off('error', onError);
      tlsSock.off('end', onEnd);
      tlsSock.off('close', onEnd);
    };
    const tlsSock = tlsConnect(
      {
        socket,
        servername: host,
        rejectUnauthorized: true,
      },
      () => {
        cleanup();
        resolve(tlsSock);
      },
    );
    function onError(err: Error): void {
      cleanup();
      tlsSock.destroy();
      reject(err);
    }
    function onTimeout(): void {
      onError(new Error('ManageSieve TLS handshake timeout'));
    }
    function onEnd(): void {
      onError(new Error('ManageSieve TLS connection closed during handshake'));
    }
    /* eslint-enable @typescript-eslint/no-use-before-define */
    const timer = setTimeout(onTimeout, SIEVE_TLS_HANDSHAKE_TIMEOUT_MS);
    tlsSock.once('error', onError);
    tlsSock.once('end', onEnd);
    tlsSock.once('close', onEnd);
  });
}

async function openConn(account: AccountConfig): Promise<SieveConn> {
  const host = account.imap.sieveHost ?? account.imap.host;
  const port = account.imap.sievePort ?? 4190;
  const raw = await connectTcp(host, port, 8_000);
  let conn: SieveConn = { socket: raw, buf: Buffer.alloc(0), lastCaps: {} };
  try {
    const greeting = await readResponse(conn);
    conn.lastCaps = parseCapabilityMap(greeting.lines);
    if (conn.lastCaps.STARTTLS !== undefined) {
      const startTls = await sendCommand(conn, 'STARTTLS');
      assertOk(startTls, 'STARTTLS');
      const tlsSock = await upgradeTls(raw, host);
      conn = { socket: tlsSock, buf: Buffer.alloc(0), lastCaps: {} };
      const postTls = await readResponse(conn);
      conn.lastCaps = parseCapabilityMap(postTls.lines);
    }
    if (!(conn.socket instanceof TLSSocket) || !conn.socket.encrypted) {
      throw new Error('ManageSieve AUTHENTICATE PLAIN requires TLS; server did not offer STARTTLS');
    }
    const user = account.username;
    const pass = account.password ?? '';
    if (!pass) {
      throw new Error('ManageSieve currently supports password authentication only');
    }
    const token = encodePlainAuth(user, pass);
    assertOk(await sendCommand(conn, `AUTHENTICATE "PLAIN" "${token}"`), 'AUTHENTICATE');
    return conn;
  } catch (err) {
    conn.socket.destroy();
    throw err;
  }
}

async function commandList(conn: SieveConn): Promise<SieveScriptInfo[]> {
  const resp = await sendCommand(conn, 'LISTSCRIPTS');
  assertOk(resp, 'LISTSCRIPTS');
  return parseListScripts(resp.lines);
}

async function withConnection<T>(
  account: AccountConfig,
  action: (conn: SieveConn) => Promise<T>,
): Promise<T> {
  let conn: SieveConn | undefined;
  try {
    conn = await openConn(account);
    return await action(conn);
  } catch (err) {
    throw redactedError(err, { user: account.username, secrets: [account.password] });
  } finally {
    conn?.socket.destroy();
  }
}

async function status(account: AccountConfig): Promise<SieveStatus> {
  const host = account.imap.sieveHost ?? account.imap.host;
  const port = account.imap.sievePort ?? 4190;
  try {
    return await withConnection(account, async (conn) => {
      const scripts = await commandList(conn);
      const caps = conn.lastCaps;
      return {
        available: true,
        host,
        port,
        implementation: caps.IMPLEMENTATION,
        sieveExtensions: (caps.SIEVE ?? '').split(/\s+/).filter(Boolean),
        scripts,
      };
    });
  } catch (err) {
    return {
      available: false,
      host,
      port,
      warning:
        'ManageSieve is not reachable. The provider may only expose filters in a web UI, ' +
        `or SIEVE may listen on a different host/port. (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

async function listScripts(account: AccountConfig): Promise<SieveScriptInfo[]> {
  return withConnection(account, commandList);
}

async function getScript(account: AccountConfig, name: string): Promise<string> {
  assertSieveScriptName(name);
  return withConnection(account, async (conn) => {
    const resp = await sendCommand(conn, `GETSCRIPT "${quoteSieve(name)}"`);
    assertOk(resp, 'GETSCRIPT');
    return conn.lastLiteral ?? '';
  });
}

async function putScript(account: AccountConfig, name: string, content: string): Promise<void> {
  assertSieveScriptName(name);
  assertSieveScriptContent(content);
  await withConnection(account, async (conn) => {
    const bytes = Buffer.byteLength(content, 'utf8');
    conn.socket.write(`PUTSCRIPT "${quoteSieve(name)}" {${bytes}+}\r\n`);
    conn.socket.write(content);
    conn.socket.write('\r\n');
    assertOk(await readResponse(conn), 'PUTSCRIPT');
  });
}

async function deleteScript(account: AccountConfig, name: string): Promise<void> {
  assertSieveScriptName(name);
  await withConnection(account, async (conn) => {
    assertOk(await sendCommand(conn, `DELETESCRIPT "${quoteSieve(name)}"`), 'DELETESCRIPT');
  });
}

async function activateScript(account: AccountConfig, name: string): Promise<void> {
  assertSieveScriptName(name, true);
  await withConnection(account, async (conn) => {
    const arg = name ? `"${quoteSieve(name)}"` : '""';
    assertOk(await sendCommand(conn, `SETACTIVE ${arg}`), 'SETACTIVE');
  });
}

const sieveService = {
  status,
  listScripts,
  getScript,
  putScript,
  deleteScript,
  activateScript,
};

export type SieveService = typeof sieveService;
export default sieveService;
