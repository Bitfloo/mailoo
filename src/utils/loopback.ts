/**
 * Host names that always mean this machine, in URL hostname form (IPv6 in brackets).
 */

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export default LOOPBACK_HOSTNAMES;
