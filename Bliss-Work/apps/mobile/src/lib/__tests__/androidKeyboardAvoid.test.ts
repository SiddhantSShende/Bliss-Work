import { keyboardPadTarget } from '../androidKeyboardAvoid';

describe('keyboardPadTarget', () => {
  it('reads the raw IME height off the event, ignoring screenY entirely', () => {
    expect(keyboardPadTarget({ endCoordinates: { height: 280, screenY: 0 } as never })).toBe(280);
  });
  it('is 0 for keyboardDidHide (no event) and for a malformed/zero event', () => {
    expect(keyboardPadTarget(null)).toBe(0);
    expect(keyboardPadTarget(undefined)).toBe(0);
    expect(keyboardPadTarget({})).toBe(0);
    expect(keyboardPadTarget({ endCoordinates: {} })).toBe(0);
    expect(keyboardPadTarget({ endCoordinates: { height: 0 } })).toBe(0);
    expect(keyboardPadTarget({ endCoordinates: { height: -1 } })).toBe(0);
  });
});

import { padAboveKeyboard } from '../androidKeyboardAvoid';

describe('padAboveKeyboard', () => {
  it('is zero without a keyboard', () => {
    expect(padAboveKeyboard(0, 24, 80)).toBe(0);
  });
  it('subtracts the tab bar the keyboard covers', () => {
    // 300 keyboard + 24 nav bar - 80 tab bar (which includes the 24)
    expect(padAboveKeyboard(300, 24, 80)).toBe(244);
  });
  it('pads the full IME when nothing sits below', () => {
    expect(padAboveKeyboard(300, 24, 0)).toBe(324);
  });
  it('never goes negative', () => {
    expect(padAboveKeyboard(40, 0, 200)).toBe(0);
  });
});
