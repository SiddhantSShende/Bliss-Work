import { joinFromCallLink, type LinkJoinDeps } from '../callLinkJoin';

const ID = '33333333-3333-4333-8333-333333333333';

function deps(confirmAnswer: boolean, redeem: LinkJoinDeps['redeemToken'] = async () => ({ id: ID, media: 'audio', title: 'Standup' })) {
  const order: string[] = [];
  const d: LinkJoinDeps = {
    confirm: jest.fn(async () => { order.push('confirm'); return confirmAnswer; }),
    redeemToken: jest.fn(async (t: string) => { order.push('redeem'); return redeem(t); }),
    join: jest.fn(() => { order.push('join'); }),
    redeemFailed: jest.fn(),
  };
  return { d, order };
}

describe('joinFromCallLink', () => {
  it('a deep link joins nothing until the user confirms', async () => {
    let answer!: (v: boolean) => void;
    const { d } = deps(true);
    d.confirm = () => new Promise<boolean>((r) => { answer = r; });
    const p = joinFromCallLink({ kind: 'call', callId: ID }, d);
    await Promise.resolve();
    expect(d.join).not.toHaveBeenCalled();
    answer(true);
    await p;
    expect(d.join).toHaveBeenCalledTimes(1);
  });

  it('a declined deep link never joins', async () => {
    const { d } = deps(false);
    await joinFromCallLink({ kind: 'call', callId: ID }, d);
    expect(d.join).not.toHaveBeenCalled();
  });

  it('a confirmed deep link joins with microphone and camera off', async () => {
    const { d } = deps(true);
    await joinFromCallLink({ kind: 'call', callId: ID }, d);
    expect(d.join).toHaveBeenCalledWith(ID, 'video', undefined, { startMuted: true });
  });

  it('an invite token is not redeemed (that is a server-side join) before confirmation', async () => {
    const { d, order } = deps(false);
    await joinFromCallLink({ kind: 'token', token: 'abc' }, d);
    expect(order).toEqual(['confirm']);
    expect(d.redeemToken).not.toHaveBeenCalled();
    expect(d.join).not.toHaveBeenCalled();
  });

  it('a confirmed invite token redeems, then joins muted', async () => {
    const { d, order } = deps(true);
    await joinFromCallLink({ kind: 'token', token: 'abc' }, d);
    expect(order).toEqual(['confirm', 'redeem', 'join']);
    expect(d.redeemToken).toHaveBeenCalledWith('abc');
    expect(d.join).toHaveBeenCalledWith(ID, 'audio', 'Standup', { startMuted: true });
  });

  it('an expired invite token reports the failure and joins nothing', async () => {
    const { d } = deps(true, async () => { throw new Error('410'); });
    await joinFromCallLink({ kind: 'token', token: 'abc' }, d);
    expect(d.redeemFailed).toHaveBeenCalled();
    expect(d.join).not.toHaveBeenCalled();
  });
});
