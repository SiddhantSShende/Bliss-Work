import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ClockTimePicker } from '../ClockTimePicker';

// The glass Modal needs GlassProvider/BlurView; the picker's own behaviour is what is under test.
jest.mock('../../Modal', () => ({ Modal: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? children : null) }));
jest.mock('../../../theme/ThemeProvider', () => ({ useThemeColors: () => require('../../../constants/theme').lightColors }));

const SIZE = 280; // jest's default window is 750 wide, so the dial is its 280 max
const CENTER = SIZE / 2;
const ring = CENTER - 20 - 2;

function setup(value = { hour: 12, minute: 7, pm: true }) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(<ClockTimePicker visible value={value} onConfirm={onConfirm} onCancel={onCancel} />);
  });
  return { r, onConfirm, onCancel };
}

const byLabel = (r: ReturnType<typeof create>, label: string): ReactTestInstance =>
  r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]!;
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const text = (r: ReturnType<typeof create>) => r.root.findAllByType('Text' as never).map((t) => t.props.children).flat().join('|');
const dial = (r: ReturnType<typeof create>) => r.root.findAll((n) => typeof n.props.onResponderGrant === 'function' && StyleSheet.flatten(n.props.style)?.width === SIZE)[0]!;
// A touch at an angle on the number ring, in the dial's own coordinates (what locationX/Y are).
let stamp = 0; // PanResponder ignores a move whose timestamp it has already accounted for
const touch = (angle: number) => {
  const rad = (angle * Math.PI) / 180;
  return {
    nativeEvent: { locationX: CENTER + ring * Math.sin(rad), locationY: CENTER - ring * Math.cos(rad) },
    touchHistory: {
      touchBank: [{ touchActive: true, startPageX: 0, startPageY: 0, startTimeStamp: 0, currentPageX: 0, currentPageY: 0, currentTimeStamp: stamp + 1, previousPageX: 0, previousPageY: 0, previousTimeStamp: stamp }],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: ++stamp,
    },
  };
};
const fire = (r: ReturnType<typeof create>, fn: 'onResponderGrant' | 'onResponderMove' | 'onResponderRelease', angle: number) =>
  act(() => { dial(r).props[fn](touch(angle)); });

describe('ClockTimePicker', () => {
  it('opens on the given time with the right AM/PM', () => {
    const { r } = setup();
    expect(text(r)).toContain('12');
    expect(text(r)).toContain('07');
    expect(byLabel(r, 'Hour 12')).toBeTruthy();
  });

  it('OK returns the unchanged time, Cancel returns nothing', () => {
    const { r, onConfirm, onCancel } = setup({ hour: 3, minute: 45, pm: false });
    const ok = r.root.findAll((n) => n.props.accessibilityRole === 'button' && n.findAll((c) => c.props.children === 'OK').length > 0)[0]!;
    const cancel = r.root.findAll((n) => n.props.accessibilityRole === 'button' && n.findAll((c) => c.props.children === 'Cancel').length > 0)[0]!;
    press(ok);
    expect(onConfirm).toHaveBeenCalledWith({ hour: 3, minute: 45, pm: false });
    press(cancel);
    expect(onCancel).toHaveBeenCalled();
  });

  it('touching the dial sets the hour, then moves on to minutes', () => {
    const { r, onConfirm } = setup();
    fire(r, 'onResponderGrant', 90); // 3 o'clock
    fire(r, 'onResponderRelease', 90);
    expect(byLabel(r, 'Hour 3').props.accessibilityState.selected).toBe(false); // switched to minutes
    expect(byLabel(r, 'Minute 07').props.accessibilityState.selected).toBe(true);
    fire(r, 'onResponderGrant', 180); // 30 minutes
    fire(r, 'onResponderRelease', 180);
    const ok = r.root.findAll((n) => n.props.accessibilityRole === 'button' && n.findAll((c) => c.props.children === 'OK').length > 0)[0]!;
    press(ok);
    expect(onConfirm).toHaveBeenCalledWith({ hour: 3, minute: 30, pm: true });
  });

  it('dragging across the minute dial follows the finger to the exact minute', () => {
    const { r, onConfirm } = setup({ hour: 5, minute: 0, pm: false });
    press(byLabel(r, 'Minute 00'));
    fire(r, 'onResponderGrant', 0);
    fire(r, 'onResponderMove', 24); // minute 4
    fire(r, 'onResponderMove', 276); // minute 46
    const ok = r.root.findAll((n) => n.props.accessibilityRole === 'button' && n.findAll((c) => c.props.children === 'OK').length > 0)[0]!;
    press(ok);
    expect(onConfirm).toHaveBeenCalledWith({ hour: 5, minute: 46, pm: false });
  });

  it('AM / PM toggles the result', () => {
    const { r, onConfirm } = setup({ hour: 12, minute: 7, pm: true });
    const am = r.root.findAll((n) => typeof n.props.onPress === 'function' && n.findAll((c) => c.props.children === 'AM').length > 0)[0]!;
    press(am);
    const ok = r.root.findAll((n) => n.props.accessibilityRole === 'button' && n.findAll((c) => c.props.children === 'OK').length > 0)[0]!;
    press(ok);
    expect(onConfirm).toHaveBeenCalledWith({ hour: 12, minute: 7, pm: false });
  });
});
