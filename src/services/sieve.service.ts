/**
 * ManageSieve (RFC 5804) client — list/get/put/delete/activate scripts.
 */

import type { Socket } from 'node:net';
import { connect as netConnect } from 'node:net';
import { TLSSocket, connect as tlsConnect } from 'node:tls';

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
  buf: string;
  lastCaps: Record<string, string>;
  lastLiteral?: string;
}

function sieveEndpoint(account: AccountConfig): { host: string; port: number } {
  return {
    host: account.imap.sieveHost ?? account.imap.host,
    port: account.imap.sievePort ?? 4190,
  };
}

export function parseListScripts(lines: string[]): SieveScriptInfo[] {
  return lines
    .map((line) => {
      const match = /^"((?:\\.|[^"\\])*)"(\s+ACTIVE)?\s*$/i.exec(line.trim());
      if (!match) return null;
      return { name: match[1].replace(/\\"/g, '"'), active: Boolean(match[2]) };
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

function writeConn(conn: SieveConn, data: string): void {
  conn.socket.write(data);
}

function destroyConn(conn: SieveConn): void {
  conn.socket.destroy();
}

export const SIEVE_IDLE_TIMEOUT_MS = 30_000;

function isTlsSocket(socket: Socket): socket is TLSSocket {
  return socket instanceof TLSSocket && socket.encrypted;
}

function applyIdleTimeout(socket: Socket): void {
  socket.setTimeout(SIEVE_IDLE_TIMEOUT_MS);
}

function bindSocketWait(
  conn: SieveConn,
  tryConsume: () => boolean,
  reject: (err: Error) => void,
): void {
  const handlers: {
    onData: (chunk: Buffer) => void;
    onError: (err: Error) => void;
    onTimeout: () => void;
  } = {
    onData: () => undefined,
    onError: () => undefined,
    onTimeout: () => undefined,
  };
  const cleanup = (): void => {
    conn.socket.off('data', handlers.onData);
    conn.socket.off('error', handlers.onError);
    conn.socket.off('timeout', handlers.onTimeout);
  };
  handlers.onData = (chunk: Buffer): void => {
    conn.buf += chunk.toString('utf8');
    if (tryConsume()) cleanup();
  };
  handlers.onError = (err: Error): void => {
    cleanup();
    reject(err);
  };
  handlers.onTimeout = (): void => {
    cleanup();
    conn.socket.destroy();
    reject(new Error('ManageSieve idle timeout'));
  };
  conn.socket.on('data', handlers.onData);
  conn.socket.once('error', handlers.onError);
  conn.socket.once('timeout', handlers.onTimeout);
}

async function readLine(conn: SieveConn): Promise<string> {
  return new Promise((resolve, reject) => {
    const tryConsume = (): boolean => {
      const idx = conn.buf.indexOf('\n');
      if (idx < 0) return false;
      const line = conn.buf.slice(0, idx).replace(/\r$/, '');
      conn.buf = conn.buf.slice(idx + 1);
      resolve(line);
      return true;
    };
    if (tryConsume()) return;
    bindSocketWait(conn, tryConsume, reject);
  });
}

async function readBytes(conn: SieveConn, n: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const tryConsume = (): boolean => {
      const bytes = Buffer.byteLength(conn.buf, 'utf8');
      if (bytes < n) return false;
      const buf = Buffer.from(conn.buf, 'utf8');
      const payload = buf.subarray(0, n).toString('utf8');
      conn.buf = buf.subarray(n).toString('utf8');
      resolve(payload);
      return true;
    };
    if (tryConsume()) return;
    bindSocketWait(conn, tryConsume, reject);
  });
}

async function readResponse(
  conn: SieveConn,
): Promise<{ code: string; lines: string[]; message: string }> {
  const lines: string[] = [];
  const readNext = async (): Promise<{ code: string; lines: string[]; message: string }> => {
    const line = await readLine(conn);
    if (/^(OK|NO|BYE)(?:\s|$)/i.test(line)) {
      return { code: line.slice(0, 2).toUpperCase(), lines, message: line };
    }
    if (line.startsWith('{')) {
      const lit = /^\{(\d+)\+?\}\s*$/.exec(line);
      if (lit) {
        const payload = await readBytes(conn, Number(lit[1]));
        lines.push(payload);
        await readLine(conn); // trailing CRLF after literal
      } else {
        lines.push(line);
      }
      return readNext();
    }
    lines.push(line);
    return readNext();
  };
  return readNext();
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
  writeConn(conn, `${command}\r\n`);
  const resp = await readResponse(conn);
  const lastLiteral = extractLiteral(resp.lines);
  if (lastLiteral !== undefined) conn.lastLiteral = lastLiteral;
  return resp;
}

function applyLiteral(conn: SieveConn, resp: { lines: string[] }): void {
  const lastLiteral = extractLiteral(resp.lines);
  if (lastLiteral !== undefined) conn.lastLiteral = lastLiteral;
}

function assertOk(resp: { code: string; message: string }, command: string): void {
  if (resp.code !== 'OK') {
    throw new Error(`${command} failed: ${resp.message}`);
  }
}

async function connectTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ManageSieve connect timed out (${host}:${port})`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function upgradeTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSock = tlsConnect({ socket, servername: host, rejectUnauthorized: true }, () => {
      resolve(tlsSock);
    });
    tlsSock.once('error', reject);
  });
}

async function openConn(account: AccountConfig): Promise<SieveConn> {
  const { host, port } = sieveEndpoint(account);
  const raw = await connectTcp(host, port, 8_000);
  applyIdleTimeout(raw);
  let conn: SieveConn = { socket: raw, buf: '', lastCaps: {} };
  try {
    const greeting = await readResponse(conn);
    conn.lastCaps = parseCapabilityMap(greeting.lines);
    if (conn.lastCaps.STARTTLS !== undefined) {
      const startTls = await sendCommand(conn, 'STARTTLS');
      assertOk(startTls, 'STARTTLS');
      const tlsSock = await upgradeTls(raw, host);
      applyIdleTimeout(tlsSock);
      conn = { socket: tlsSock, buf: '', lastCaps: {} };
      const postTls = await readResponse(conn);
      conn.lastCaps = parseCapabilityMap(postTls.lines);
    }
    if (!isTlsSocket(conn.socket)) {
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
    destroyConn(conn);
    throw err;
  }
}

async function commandList(conn: SieveConn): Promise<SieveScriptInfo[]> {
  const resp = await sendCommand(conn, 'LISTSCRIPTS');
  assertOk(resp, 'LISTSCRIPTS');
  return parseListScripts(resp.lines);
}

async function status(account: AccountConfig): Promise<SieveStatus> {
  const { host, port } = sieveEndpoint(account);
  try {
    const conn = await openConn(account);
    try {
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
    } finally {
      destroyConn(conn);
    }
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
  const conn = await openConn(account);
  try {
    return await commandList(conn);
  } finally {
    destroyConn(conn);
  }
}

async function getScript(account: AccountConfig, name: string): Promise<string> {
  const conn = await openConn(account);
  try {
    const resp = await sendCommand(conn, `GETSCRIPT "${quoteSieve(name)}"`);
    applyLiteral(conn, resp);
    assertOk(resp, 'GETSCRIPT');
    return conn.lastLiteral ?? '';
  } finally {
    destroyConn(conn);
  }
}

async function putScript(account: AccountConfig, name: string, content: string): Promise<void> {
  const conn = await openConn(account);
  try {
    const bytes = Buffer.byteLength(content, 'utf8');
    writeConn(conn, `PUTSCRIPT "${quoteSieve(name)}" {${bytes}+}\r\n`);
    writeConn(conn, content);
    writeConn(conn, '\r\n');
    assertOk(await readResponse(conn), 'PUTSCRIPT');
  } finally {
    destroyConn(conn);
  }
}

async function deleteScript(account: AccountConfig, name: string): Promise<void> {
  const conn = await openConn(account);
  try {
    assertOk(await sendCommand(conn, `DELETESCRIPT "${quoteSieve(name)}"`), 'DELETESCRIPT');
  } finally {
    destroyConn(conn);
  }
}

async function activateScript(account: AccountConfig, name: string): Promise<void> {
  const conn = await openConn(account);
  try {
    const arg = name ? `"${quoteSieve(name)}"` : '""';
    assertOk(await sendCommand(conn, `SETACTIVE ${arg}`), 'SETACTIVE');
  } finally {
    destroyConn(conn);
  }
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
