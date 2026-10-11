import { MAX_ADHOC_CALL_PARTICIPANTS, type CallDTO } from '@taskboard/shared';
import {
  CONFERENCE_TITLE,
  MAX_CONFERENCE_PEOPLE,
  MIN_CONFERENCE_PEOPLE,
  canCallTogether,
  startConferenceCall,
} from '../conferenceCall';

const CALL = '33333333-3333-4333-8333-333333333333';
const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

function deps(over: { busy?: boolean; fail?: Error } = {}) {
  const api = {
    startConferenceCall: jest.fn(async () => {
      if (over.fail) throw over.fail;
      return { id: CALL } as CallDTO;
    }),
  };
  const join = jest.fn();
  return { api, join, d: { api, busy: () => !!over.busy, join } };
}

describe('the multi-select Call', () => {
  it('makes exactly ONE call for everyone picked and joins its room, titled as a conference call', async () => {
    const { api, join, d } = deps();
    const picked = ids(3);

    const out = await startConferenceCall(d, picked, 'video');

    expect(out).toEqual({ ok: true, callId: CALL });
    expect(api.startConferenceCall).toHaveBeenCalledTimes(1);
    expect(api.startConferenceCall).toHaveBeenCalledWith(picked, 'video');
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith(CALL, 'video', CONFERENCE_TITLE);
    expect(CONFERENCE_TITLE).not.toMatch(/meeting/i);
  });

  it('needs two people and no more than the call can seat', () => {
    expect(MIN_CONFERENCE_PEOPLE).toBe(2);
    // The caller takes a seat too.
    expect(MAX_CONFERENCE_PEOPLE).toBe(MAX_ADHOC_CALL_PARTICIPANTS - 1);
    expect([0, 1].map(canCallTogether)).toEqual([false, false]);
    expect(canCallTogether(2)).toBe(true);
    expect(canCallTogether(MAX_CONFERENCE_PEOPLE)).toBe(true);
    expect(canCallTogether(MAX_CONFERENCE_PEOPLE + 1)).toBe(false);
  });

  it.each([[1], [MAX_CONFERENCE_PEOPLE + 1]])('refuses %i people without asking the server', async (n) => {
    const { api, join, d } = deps();
    const out = await startConferenceCall(d, ids(n), 'video');
    expect(out.ok).toBe(false);
    expect(api.startConferenceCall).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('will not start a second call while already in one', async () => {
    const { api, join, d } = deps({ busy: true });
    const out = await startConferenceCall(d, ids(2), 'audio');
    expect(out).toEqual({ ok: false, message: 'You are already in a call' });
    expect(api.startConferenceCall).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as is, and does not join a room", async () => {
    const { join, d } = deps({ fail: new Error('forbidden') });
    const out = await startConferenceCall(d, ids(2), 'video');
    expect(out).toEqual({ ok: false, message: 'forbidden' });
    expect(join).not.toHaveBeenCalled();
  });
});
