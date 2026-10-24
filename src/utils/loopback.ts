import { isIPv4, isIPv6 } from 'node:net';

export const LOOPBACK_HOSTS_TEXT = 'localhost, 127.0.0.0/8 or ::1';

// Exact spellings only, no DNS: a mail client looks up anything that is not an IP literal
// as a name, so '127.1', 'localhost.' or a padded host may resolve elsewhere.
export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  if (isIPv4(host)) return host.startsWith('127.');
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIPv6(literal) && URL.parse(`http://[${literal}]`)?.hostname === '[::1]';
}
