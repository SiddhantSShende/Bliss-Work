/**
 * Development-only request diagnostics. Wraps global fetch and logs ONLY failed
 * requests as `METHOD /path -> STATUS message`. Never logs headers, bodies,
 * cookies, tokens, or query strings (which can carry tokens). Compiled out of
 * release builds: installed only when `__DEV__` is true.
 */
export function installDevNetworkLog(): void {
  if (!__DEV__) return;
  const g = globalThis as { fetch: typeof fetch; __tbFetchLogged?: boolean };
  if (g.__tbFetchLogged) return;
  g.__tbFetchLogged = true;
  const original = g.fetch.bind(globalThis);

  g.fetch = async (input, init) => {
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET') ?? 'GET').toUpperCase();
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    try {
      const res = await original(input, init);
      if (!res.ok) console.warn(`[net] ${method} ${path} -> ${res.status} ${res.statusText}`);
      return res;
    } catch (e) {
      console.warn(`[net] ${method} ${path} -> failed: ${e instanceof Error ? e.message : 'network error'}`);
      throw e;
    }
  };
}
