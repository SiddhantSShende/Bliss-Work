import { parseCallLink } from '../callLinks';

const WEB = 'https://app.blisswork.example';
const ID = '33333333-3333-4333-8333-333333333333';

describe('parseCallLink', () => {
  it('recognises the app deep link', () => {
    expect(parseCallLink(`blisswork://call/${ID}`, WEB)).toEqual({ kind: 'call', callId: ID });
  });
  it('recognises the web call URL that opened Chrome before', () => {
    expect(parseCallLink(`${WEB}/call/${ID}`, WEB)).toEqual({ kind: 'call', callId: ID });
    expect(parseCallLink(`${WEB}/call/${ID}/`, WEB)).toEqual({ kind: 'call', callId: ID });
  });
  it('recognises an invite link', () => {
    expect(parseCallLink(`${WEB}/join?t=abc123`, WEB)).toEqual({ kind: 'token', token: 'abc123' });
  });
  it('leaves ordinary links alone', () => {
    expect(parseCallLink('https://example.com/page', WEB)).toBeNull();
    expect(parseCallLink(`${WEB}/settings`, WEB)).toBeNull();
    expect(parseCallLink(`${WEB}/join`, WEB)).toBeNull();
    expect(parseCallLink('mailto:a@b.co', WEB)).toBeNull();
    expect(parseCallLink('not a url', WEB)).toBeNull();
  });
  it('does not match a look-alike origin or a non-uuid id', () => {
    expect(parseCallLink(`https://app.blisswork.example.evil.com/call/${ID}`, WEB)).toBeNull();
    expect(parseCallLink(`https://evil.com/call/${ID}`, WEB)).toBeNull();
    expect(parseCallLink(`${WEB}/call/not-a-uuid`, WEB)).toBeNull();
    expect(parseCallLink('blisswork://call/nope', WEB)).toBeNull();
  });
});
