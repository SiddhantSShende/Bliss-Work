/**
 * Turn a STALLED (never resolves, never rejects) promise into a genuine
 * rejection after `timeoutMs`.
 *
 * Built for dynamic `import()`. A hard refresh wipes the whole JS module
 * graph AND every Service Worker/Cache Storage entry (see
 * apps/web/src/main.tsx's self-heal on load), so a lazy chunk is always a
 * genuine cold network fetch at exactly the moment the page's own network
 * stack is coldest. A request that STALLS rather than outright failing has
 * nothing in `React.lazy`/`Suspense` to resolve it — the fallback just sits
 * on screen forever, with no error and nothing to recover it. Racing a
 * timeout is what gives a caller (an ErrorBoundary, a reload-once recovery)
 * something to actually catch.
 */
export function withLoadTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
