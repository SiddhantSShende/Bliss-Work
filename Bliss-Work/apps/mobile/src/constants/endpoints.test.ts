import { devEndpoints, devHost, PROD_ENDPOINTS, resolveEndpoints } from './endpoints';

describe('devHost', () => {
  it('maps the Android emulator to its host-loopback alias', () => {
    expect(devHost('android')).toBe('10.0.2.2');
  });

  it('maps iOS Simulator straight to localhost', () => {
    expect(devHost('ios')).toBe('localhost');
  });
});

describe('resolveEndpoints', () => {
  it('resolves to the production origin when isProd is true', () => {
    expect(resolveEndpoints(true, 'ios')).toEqual(PROD_ENDPOINTS);
  });

  it('resolves to the per-platform dev host when isProd is false', () => {
    expect(resolveEndpoints(false, 'android')).toEqual(devEndpoints('android'));
    expect(resolveEndpoints(false, 'ios')).toEqual(devEndpoints('ios'));
  });

  it('lets an override win over the platform default', () => {
    const resolved = resolveEndpoints(false, 'android', { authBase: 'http://192.168.1.5:8001' });
    expect(resolved.authBase).toBe('http://192.168.1.5:8001');
    // Every other key falls through to the android dev default untouched.
    expect(resolved.taskBase).toBe(devEndpoints('android').taskBase);
  });

  it('ignores an empty-string override and falls through to the default', () => {
    const resolved = resolveEndpoints(true, 'ios', { authBase: '' });
    expect(resolved.authBase).toBe(PROD_ENDPOINTS.authBase);
  });
});
