import { mix } from '../mix';

describe('mix', () => {
  it('blends colours and hits the endpoints exactly', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#ff0000', '#0000ff', 0.5)).toBe('#800080');
  });
  it('never throws on a colour it cannot parse', () => {
    expect(mix('rgba(1,2,3,1)', '#ffffff', 0.5)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
