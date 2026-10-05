import { isOpen, participantsLabel, shortMeetingId, whenLabel } from '../detailFormat';

const NOW = new Date(2026, 8, 28, 9, 0, 0); // Mon 28 Sep 2026, local

const local = (y: number, m: number, d: number, h: number, mi: number) => new Date(y, m, d, h, mi).toISOString();

describe('whenLabel', () => {
  it('says Today / Tomorrow / Yesterday for nearby days, with the time range', () => {
    const today = whenLabel(local(2026, 8, 28, 10, 0), local(2026, 8, 28, 10, 30), NOW);
    expect(today.startsWith('Today, ')).toBe(true);
    expect(today).toContain(' – ');
    expect(whenLabel(local(2026, 8, 29, 10, 0), null, NOW).startsWith('Tomorrow, ')).toBe(true);
    expect(whenLabel(local(2026, 8, 27, 10, 0), null, NOW).startsWith('Yesterday, ')).toBe(true);
  });
  it('uses a dated label further out, and a single time when there is no end', () => {
    const later = whenLabel(local(2026, 9, 5, 16, 0), null, NOW);
    expect(later).not.toMatch(/^(Today|Tomorrow|Yesterday)/);
    expect(later).not.toContain(' – ');
  });
  it('is safe on missing or bad input', () => {
    expect(whenLabel(null, null, NOW)).toBe('No time set');
    expect(whenLabel('garbage', null, NOW)).toBe('No time set');
  });
});

describe('labels', () => {
  it('shortens a meeting id to its first 8 hex digits, upper-case', () => {
    expect(shortMeetingId('3f2a91bc-1111-4222-8333-444455556666')).toBe('3F2A91BC');
  });
  it('knows which meetings are still open', () => {
    expect(isOpen('SCHEDULED')).toBe(true);
    expect(isOpen('LIVE')).toBe(true);
    expect(isOpen('ENDED')).toBe(false);
    expect(isOpen('CANCELLED')).toBe(false);
  });
  it('pluralises participants', () => {
    expect(participantsLabel(1)).toBe('1 participant');
    expect(participantsLabel(8)).toBe('8 participants');
  });
});
