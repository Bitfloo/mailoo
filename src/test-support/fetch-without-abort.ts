/**
 * Preloaded (node --import) into the children of the entry-order tests only; never built or shipped.
 * The child's real fetch, minus the abort signal: a count request the test's collector holds
 * stays open until the test ends, so those tests do not race the child's 3 s bound.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => realFetch(input, { ...init, signal: null });
