import {
  GRACE_MS,
  classifyStart,
  durationMinutes,
  startsInLabel,
  to24Hour,
  toClock12,
  validateMeeting,
  withCalendarDay,
  withClock12,
  formatTimeField,
  formatDateField,
} from '../meetingSchedule';

const at = (h: number, m = 0, day = 28) => new Date(2026, 8, day, h, m, 0, 0); // 28 Sep 2026, local time

describe('classifyStart (Start Now vs Schedule)', () => {
  const now = at(15, 0).getTime();
  it('is "now" for the current time and inside the grace window', () => {
    expect(classifyStart(at(15, 0), now)).toBe('now');
    expect(classifyStart(new Date(now + GRACE_MS), now)).toBe('now');
    expect(classifyStart(new Date(now - GRACE_MS), now)).toBe('now');
  });
  it('is "future" 16 minutes ahead — today is NOT automatically Start Now', () => {
    expect(classifyStart(at(15, 16), now)).toBe('future');
    expect(classifyStart(at(15, 1, 29), now)).toBe('future');
  });
  it('is "past" once the start is more than the grace window behind', () => {
    expect(classifyStart(at(14, 58), now)).toBe('past');
  });
});

describe('validateMeeting', () => {
  const now = at(15, 0).getTime();
  const ok = { title: 'Team', startAt: at(16, 0), endAt: at(17, 0), now };
  it('accepts a valid future meeting', () => expect(validateMeeting(ok)).toEqual({}));
  it('requires a title', () => expect(validateMeeting({ ...ok, title: '  ' }).title).toBeTruthy());
  it('rejects a start time that has passed', () => {
    expect(validateMeeting({ ...ok, startAt: at(14, 0), endAt: at(15, 30) }).start).toBe('Start time has already passed.');
  });
  it('rejects an end at or before the start', () => {
    expect(validateMeeting({ ...ok, startAt: at(16, 0), endAt: at(15, 0) }).end).toBe('End time must be after start time.');
    expect(validateMeeting({ ...ok, endAt: at(16, 0) }).end).toBe('End time must be after start time.');
  });
  it('allows a meeting that crosses midnight', () => {
    expect(validateMeeting({ ...ok, startAt: at(23, 0), endAt: at(1, 0, 29) })).toEqual({});
  });
});

describe('12-hour clock', () => {
  it('reads 15:16 as 03:16 PM, not AM', () => {
    expect(toClock12(at(15, 16))).toEqual({ hour: 3, minute: 16, pm: true });
    expect(formatTimeField(at(15, 16))).toBe('03:16 PM');
  });
  it('handles midnight and noon', () => {
    expect(to24Hour(12, false)).toBe(0);
    expect(to24Hour(12, true)).toBe(12);
    expect(formatTimeField(at(0, 5))).toBe('12:05 AM');
    expect(formatTimeField(at(12, 0))).toBe('12:00 PM');
  });
  it('round-trips every minute of the day', () => {
    for (let h = 0; h < 24; h++) {
      const d = at(h, 30);
      expect(withClock12(d, toClock12(d)).getTime()).toBe(d.getTime());
    }
  });
  it('setting a time keeps the day; setting a day keeps the time', () => {
    const t = withClock12(at(9, 0, 30), { hour: 3, minute: 16, pm: true });
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([30, 15, 16]);
    const d = withCalendarDay(at(15, 16), 2026, 9, 5);
    expect([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([9, 5, 15, 16]);
  });
  it('formats the date like the reference', () => expect(formatDateField(at(1))).toBe('28-09-2026'));
});

describe('helpers', () => {
  it('computes the duration to send', () => expect(durationMinutes(at(15, 16), at(16, 14))).toBe(58));
  it('words the countdown', () => {
    const now = at(15, 0).getTime();
    expect(startsInLabel(at(15, 8), now)).toBe('Starts in 8 minutes');
    expect(startsInLabel(at(15, 1), now)).toBe('Starts in 1 minute');
    expect(startsInLabel(at(17, 0), now)).toBe('Starts in 2 hours');
    expect(startsInLabel(at(14, 0), now)).toBeNull();
  });
});

describe('invitees and the live preview', () => {
  const { MAX_MEETING_INVITEES, mergeInviteeIds, inviteesSummary, describeWhen, relativeDayLabel } = require('../meetingSchedule');
  const clock = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  it('mergeInviteeIds de-duplicates across lists, keeping order', () => {
    expect(mergeInviteeIds(['a', 'b'], ['b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });
  it('knows the server cap', () => {
    expect(MAX_MEETING_INVITEES).toBe(200);
  });
  it('summarises who is invited', () => {
    expect(inviteesSummary([], [])).toBe('No one invited yet');
    expect(inviteesSummary(['Priya'], [])).toBe('Priya');
    expect(inviteesSummary(['Priya', 'Sam'], [])).toBe('Priya, Sam');
    expect(inviteesSummary(['A', 'B', 'C', 'D'], [])).toBe('A, B +2 more');
    expect(inviteesSummary([], ['general'])).toBe('#general');
    expect(inviteesSummary(['Priya'], ['general', 'design', 'ops'])).toBe('Priya · #general, #design +1 more');
  });
  it('labels the day relative to now', () => {
    const now = new Date(2026, 9, 1, 12, 7).getTime();
    expect(relativeDayLabel(new Date(2026, 9, 1, 18, 0), now)).toBe('Today');
    expect(relativeDayLabel(new Date(2026, 9, 2, 9, 0), now)).toBe('Tomorrow');
    expect(relativeDayLabel(new Date(2026, 9, 5, 9, 0), now)).not.toMatch(/Today|Tomorrow/);
  });
  it('describes a same-day and a cross-midnight meeting', () => {
    const now = new Date(2026, 9, 1, 12, 7).getTime();
    expect(describeWhen(new Date(2026, 9, 1, 12, 7), new Date(2026, 9, 1, 13, 7), now, clock)).toBe('Today · 12:07 – 13:07');
    expect(describeWhen(new Date(2026, 9, 1, 23, 30), new Date(2026, 9, 2, 0, 30), now, clock)).toBe('Today 23:30 – Tomorrow 0:30');
  });
});
