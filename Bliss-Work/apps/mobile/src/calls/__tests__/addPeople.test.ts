import {
  addPeopleSequentially,
  alreadyInCallIds,
  backAction,
  describeAddFailure,
  pendingInvitees,
  summarizeOutcome,
} from '../addPeople';

const A = { id: 'a', name: 'Ana' };
const B = { id: 'b', name: 'Ben' };
const C = { id: 'c', name: 'Cy' };

describe('describeAddFailure', () => {
  it('explains the deliberately vague 403', () => {
    expect(describeAddFailure({ status: 403, message: 'forbidden' })).toMatch(/can't be added/);
  });
  it('knows an ended call', () => {
    expect(describeAddFailure({ status: 409 })).toMatch(/ended/);
    expect(describeAddFailure({ status: 404 })).toMatch(/no longer exists/);
  });
  it('falls back to a short server message, else a network sentence', () => {
    expect(describeAddFailure({ status: 500, message: 'db is on fire' })).toBe('db is on fire');
    expect(describeAddFailure(new Error(''))).toMatch(/server/);
    expect(describeAddFailure(undefined)).toMatch(/server/);
  });
});

describe('addPeopleSequentially', () => {
  it('runs in order, one at a time, and dedupes', async () => {
    const log: string[] = [];
    let inFlight = 0;
    const r = await addPeopleSequentially([A, B, A], async (id) => {
      inFlight++;
      expect(inFlight).toBe(1);
      log.push(id);
      await Promise.resolve();
      inFlight--;
    });
    expect(log).toEqual(['a', 'b']);
    expect(r.added).toEqual([A, B]);
  });
  it('never stops at the first failure', async () => {
    const r = await addPeopleSequentially([A, B, C], async (id) => {
      if (id === 'a') throw { status: 403 };
    });
    expect(r.added).toEqual([B, C]);
    expect(r.failed).toEqual([{ ...A, message: expect.stringMatching(/can't be added/) }]);
  });
});

describe('summarizeOutcome', () => {
  it('success', () => {
    expect(summarizeOutcome({ added: [A], failed: [], movedToRoom: false })).toEqual({ tone: 'success', text: 'Ringing Ana' });
    expect(summarizeOutcome({ added: [A, B, C], failed: [], movedToRoom: true }).text).toBe('Ringing Ana and 2 others');
  });
  it('all failed is an error naming each person and reason', () => {
    const n = summarizeOutcome({ added: [], failed: [{ ...A, message: 'nope' }], movedToRoom: false });
    expect(n.tone).toBe('error');
    expect(n.text).toContain('Ana: nope');
  });
  it('mixed keeps the failure visible', () => {
    const n = summarizeOutcome({ added: [A], failed: [{ ...B, message: 'blocked' }], movedToRoom: false });
    expect(n.tone).toBe('mixed');
    expect(n.text).toContain('Ringing Ana');
    expect(n.text).toContain('Ben: blocked');
  });
});

describe('pendingInvitees / alreadyInCallIds', () => {
  const inv = [{ ...A, at: 1000 }, { ...B, at: 1000 }];
  it('drops people who joined and people past the ring window', () => {
    expect(pendingInvitees(inv, ['a'], 2000).map((p) => p.id)).toEqual(['b']);
    expect(pendingInvitees(inv, [], 1000 + 30_000).map((p) => p.id)).toEqual([]);
  });
  it('never offers anyone already in or being rung, or the 1:1 peer', () => {
    expect(alreadyInCallIds(['me', 'a'], [B], ['peer', undefined]).sort()).toEqual(['a', 'b', 'me', 'peer']);
  });
});

describe('backAction', () => {
  it('dismisses finished screens', () => {
    expect(backAction('ended', 'idle')).toBe('dismiss');
    expect(backAction('failed', 'idle')).toBe('dismiss');
    expect(backAction('idle', 'ended')).toBe('dismiss');
  });
  it('asks before leaving a live call, never ends it silently', () => {
    for (const p of ['outgoing', 'connecting', 'connected', 'reconnecting']) expect(backAction(p, 'idle')).toBe('confirm-leave');
    for (const p of ['joining', 'waiting', 'connected', 'reconnecting']) expect(backAction('idle', p)).toBe('confirm-leave');
  });
  it('leaves a ring alone', () => {
    expect(backAction('incoming', 'idle')).toBe('ignore');
    expect(backAction('idle', 'ringing')).toBe('ignore');
  });
});
