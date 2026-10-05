/**
 * The pure half of Android's keyboard-avoidance fix (see
 * `components/ChatKeyboardAvoider.tsx` for why `KeyboardAvoidingView`'s own
 * Android "padding" math doesn't work here): given a `keyboardDidShow` /
 * `keyboardDidHide` event, what bottom padding to animate to.
 *
 * Deliberately reads ONLY `endCoordinates.height` — that value comes straight
 * from the IME WindowInsets (`imeInsets.bottom - barInsets.bottom`, see
 * react-native's `ReactRootView.checkForKeyboardEvents()`), unlike
 * `screenY`/`screenX`, which are derived from the legacy
 * `getWindowVisibleDisplayFrame()` and go stale once the window stops
 * actually resizing.
 */
export interface KeyboardHeightEvent {
  endCoordinates?: { height?: number } | null;
}

/** Default animation length when the event carries none (Android's
 *  `keyboardDidShow`/`Did`Hide never do; only iOS's `will*` events do). */
export const KEYBOARD_PAD_DURATION_MS = 220;

export function keyboardPadTarget(event: KeyboardHeightEvent | null | undefined): number {
  const h = event?.endCoordinates?.height;
  return typeof h === 'number' && h > 0 ? h : 0;
}

/**
 * Bottom padding for a container whose bottom edge is NOT the bottom of the
 * window. Inside a bottom-tab navigator the screen ends at the top of the tab
 * bar; the keyboard covers the tab bar too, so only the part of the keyboard
 * that rises ABOVE the tab bar's top edge may be padded — padding the full
 * keyboard height (what this did before) floats the composer a whole tab-bar
 * height above the keyboard, the "blank space" under the chat input.
 *
 * `keyboardHeight` is the event's `height` (IME minus the system-bar inset),
 * `bottomInset` the navigation-bar inset, `belowHeight` the height of what sits
 * under the container (the tab bar, which already includes that inset; 0 when
 * the container reaches the window's bottom).
 */
export function padAboveKeyboard(keyboardHeight: number, bottomInset: number, belowHeight: number): number {
  if (!(keyboardHeight > 0)) return 0;
  return Math.max(0, Math.round(keyboardHeight + bottomInset - belowHeight));
}
