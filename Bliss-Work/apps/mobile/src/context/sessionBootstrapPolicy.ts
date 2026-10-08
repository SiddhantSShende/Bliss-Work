export function shouldRetrySessionBootstrap(session: unknown | null, sessionDead: boolean): boolean {
  return session === null && !sessionDead;
}

export function sessionBootstrapRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 30_000);
}
