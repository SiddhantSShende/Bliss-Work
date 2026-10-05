import { createContext, useContext } from 'react';

/**
 * Lets a scrolling form (the signed-out screens) hear that one of its inputs
 * just took focus, so it can scroll that input clear of the keyboard — needed
 * when the user hops from one field to the next while the keyboard is already
 * open, which fires no keyboard event. `TextField` calls it on focus; outside
 * such a form there is no provider and it is a no-op.
 */
export const FocusScrollContext = createContext<(() => void) | null>(null);

export const useFocusScroll = () => useContext(FocusScrollContext);
