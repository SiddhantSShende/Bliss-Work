/**
 * Which URLs are BlissWork CALL links (and so must open the in-app call
 * screen), as opposed to ordinary links (left to the OS/browser exactly as
 * before — this is deliberately NOT a global link interceptor).
 *
 *   blisswork://call/<callId>          the app's own deep link
 *   <webBaseUrl>/call/<callId>         what web/desktop put in chat & emails
 *   <webBaseUrl>/join?t=<token>        an invite link ("Send Call Link")
 *
 * Only the BlissWork web origin is recognised, so a look-alike host never
 * matches.
 */
export type CallLink = { kind: 'call'; callId: string } | { kind: 'token'; token: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCallLink(rawUrl: string, webBaseUrl: string): CallLink | null {
  const url = rawUrl.trim();
  const deep = /^blisswork:\/\/call\/([^/?#]+)/i.exec(url);
  if (deep) return UUID.test(deep[1]!) ? { kind: 'call', callId: deep[1]! } : null;

  let base: URL;
  let u: URL;
  try {
    base = new URL(webBaseUrl);
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== base.origin) return null;
  const call = /^\/call\/([^/]+)\/?$/.exec(u.pathname);
  if (call) return UUID.test(call[1]!) ? { kind: 'call', callId: call[1]! } : null;
  if (/^\/join\/?$/.test(u.pathname)) {
    const token = u.searchParams.get('t');
    return token ? { kind: 'token', token } : null;
  }
  return null;
}
