import { clampSlide, slideDecision, SLIDE_COMMIT_RATIO } from '../slideToAnswer';

describe('slideDecision', () => {
  const range = 100;
  it('commits to answer past the threshold to the right', () => {
    expect(slideDecision(range * SLIDE_COMMIT_RATIO, range)).toBe('answer');
    expect(slideDecision(range, range)).toBe('answer');
  });
  it('commits to decline past the threshold to the left', () => {
    expect(slideDecision(-range * SLIDE_COMMIT_RATIO, range)).toBe('decline');
    expect(slideDecision(-range, range)).toBe('decline');
  });
  it('does nothing for a short drag either way', () => {
    expect(slideDecision(0, range)).toBeNull();
    expect(slideDecision(range * 0.5, range)).toBeNull();
    expect(slideDecision(-range * 0.5, range)).toBeNull();
  });
  it('never commits before the track has been measured', () => {
    expect(slideDecision(500, 0)).toBeNull();
  });
  it('clamps drags to the track', () => {
    expect(clampSlide(999, range)).toBe(range);
    expect(clampSlide(-999, range)).toBe(-range);
    expect(clampSlide(20, range)).toBe(20);
  });
});
