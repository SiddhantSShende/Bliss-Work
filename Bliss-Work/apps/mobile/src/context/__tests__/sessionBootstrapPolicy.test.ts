import { sessionBootstrapRetryDelay, shouldRetrySessionBootstrap } from '../sessionBootstrapPolicy';

describe('session bootstrap retry policy', () => {
  it('retries a transient null refresh result instead of treating it as logout', () => {
    expect(shouldRetrySessionBootstrap(null, false)).toBe(true);
  });

  it('stops retrying after a terminal refresh failure', () => {
    expect(shouldRetrySessionBootstrap(null, true)).toBe(false);
  });

  it('stops retrying when refresh succeeds', () => {
    expect(shouldRetrySessionBootstrap({ accessToken: 'token' }, false)).toBe(false);
  });

  it('backs off retries and caps the delay', () => {
    expect([1, 2, 3, 20].map(sessionBootstrapRetryDelay)).toEqual([1_000, 2_000, 4_000, 30_000]);
  });
});
