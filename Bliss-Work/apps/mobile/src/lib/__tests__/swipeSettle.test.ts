import { SWIPE_OPEN_WIDTH, swipeSettle } from '../swipeSettle';

const W = 400;

describe('swipeSettle', () => {
  it('closes after a small accidental swipe', () => {
    expect(swipeSettle(0, -10, W)).toBe('close');
    expect(swipeSettle(0, -39, W)).toBe('close');
  });

  it('opens on a partial left swipe', () => {
    expect(swipeSettle(0, -60, W)).toBe('open');
    expect(swipeSettle(0, -150, W)).toBe('open');
  });

  it('deletes only past half the row', () => {
    expect(swipeSettle(0, -200, W)).toBe('open');
    expect(swipeSettle(0, -201, W)).toBe('delete');
    expect(swipeSettle(0, -390, W)).toBe('delete');
  });

  it('never opens or deletes on a rightward drag from closed', () => {
    expect(swipeSettle(0, 120, W)).toBe('close');
  });

  it('closes an open row on a tap or a drag back to the right', () => {
    expect(swipeSettle(-SWIPE_OPEN_WIDTH, 0, W)).toBe('close');
    expect(swipeSettle(-SWIPE_OPEN_WIDTH, 3, W)).toBe('close');
    expect(swipeSettle(-SWIPE_OPEN_WIDTH, 40, W)).toBe('close');
  });

  it('keeps an open row open on a small nudge, and deletes if pulled the rest of the way', () => {
    expect(swipeSettle(-SWIPE_OPEN_WIDTH, -15, W)).toBe('open');
    expect(swipeSettle(-SWIPE_OPEN_WIDTH, 12, W)).toBe('open');
    expect(swipeSettle(-SWIPE_OPEN_WIDTH, -130, W)).toBe('delete');
  });
});
