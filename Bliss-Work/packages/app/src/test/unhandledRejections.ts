/**
 * Records promise rejections that nothing handled while a test runs.
 *
 * Vitest only reports these as a run-level error, far from the test that caused
 * them, so a component that fires an async handler and forgets to catch it
 * would still pass its own assertions. Call `stop()` in a `finally`.
 */
export function trackUnhandledRejections() {
  const seen: unknown[] = [];
  const record = (reason: unknown) => void seen.push(reason);
  process.on("unhandledRejection", record);
  return {
    /** Node reports an unhandled rejection only once the microtask queue has drained, so wait a macrotask first. */
    async unhandled() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return [...seen];
    },
    stop: () => void process.off("unhandledRejection", record),
  };
}
