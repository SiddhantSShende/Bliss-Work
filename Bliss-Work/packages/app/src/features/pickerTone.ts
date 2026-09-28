/** How a picker is painted. "theme" follows the user's chosen theme, like the rest
 *  of the app. "light" is for a form that is deliberately a white card in every
 *  theme (NewMeetingDialog): the theme tokens flip to dark surfaces with pale text
 *  in dark mode, which inside a white card is a dark box on white. */
export type PickerTone = "theme" | "light";

export interface PickerClasses {
  input: string;
  icon: string;
  list: string;
  muted: string;
  text: string;
  on: string;
  off: string;
  /** Extra classes for an Avatar shown on this surface. Its outline ring is drawn
   *  in the theme's surface colour, which in dark mode is a dark ring around a
   *  face on a white card; re-scoping the token to white for that subtree fixes it
   *  without touching the shared Avatar. */
  avatar: string;
}

export const PICKER_TONES: Record<PickerTone, PickerClasses> = {
  theme: {
    input: "border-border bg-surface-2 text-fg focus:border-accent",
    icon: "text-muted",
    list: "border-border",
    muted: "text-muted",
    text: "text-fg",
    on: "bg-accent-soft",
    off: "hover:bg-surface-2",
    avatar: "",
  },
  light: {
    input:
      "border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent",
    icon: "text-gray-400",
    list: "border-gray-200 bg-white",
    muted: "text-gray-500",
    text: "text-gray-900",
    on: "bg-accent/10",
    off: "hover:bg-gray-100",
    avatar: "[--color-surface:#fff]",
  },
};
