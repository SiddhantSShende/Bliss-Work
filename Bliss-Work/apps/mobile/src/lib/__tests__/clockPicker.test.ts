import { angleToHour, angleToMinute, hourToAngle, minuteToAngle, pointToAngle, polar } from '../clockPicker';

describe('pointToAngle', () => {
  it('measures clockwise from 12 o\'clock (screen y grows downward)', () => {
    expect(pointToAngle(0, -10)).toBeCloseTo(0); // straight up = 12
    expect(pointToAngle(10, 0)).toBeCloseTo(90); // right = 3
    expect(pointToAngle(0, 10)).toBeCloseTo(180); // down = 6
    expect(pointToAngle(-10, 0)).toBeCloseTo(270); // left = 9
  });
});

describe('angle <-> hour/minute', () => {
  it('maps the 12 numbers and puts 12 at the top', () => {
    expect(angleToHour(0)).toBe(12);
    expect(angleToHour(30)).toBe(1);
    expect(angleToHour(90)).toBe(3);
    expect(angleToHour(180)).toBe(6);
    expect(angleToHour(330)).toBe(11);
  });
  it('snaps to the nearest hour, including either side of 12', () => {
    expect(angleToHour(14)).toBe(12);
    expect(angleToHour(16)).toBe(1);
    expect(angleToHour(346)).toBe(12);
    expect(angleToHour(344)).toBe(11);
  });
  it('maps minutes, with 0 at the top and 59 wrapping to 0 past 357 degrees', () => {
    expect(angleToMinute(0)).toBe(0);
    expect(angleToMinute(90)).toBe(15);
    expect(angleToMinute(180)).toBe(30);
    expect(angleToMinute(270)).toBe(45);
    expect(angleToMinute(354)).toBe(59);
    expect(angleToMinute(359)).toBe(0);
  });
  it('round-trips every hour and every minute', () => {
    for (let h = 1; h <= 12; h++) expect(angleToHour(hourToAngle(h))).toBe(h);
    for (let m = 0; m < 60; m++) expect(angleToMinute(minuteToAngle(m))).toBe(m);
  });
  it('accepts out-of-range angles', () => {
    expect(angleToHour(390)).toBe(1);
    expect(angleToMinute(-90)).toBe(45);
  });
});

describe('polar', () => {
  it('places 12 above the centre and 3 to its right', () => {
    const top = polar(0, 100);
    expect(top.x).toBeCloseTo(0);
    expect(top.y).toBeCloseTo(-100);
    const right = polar(90, 100);
    expect(right.x).toBeCloseTo(100);
    expect(right.y).toBeCloseTo(0);
  });
});
