import type { PickerTone } from "./pickerTone";

/** The palette of the meeting form's own chrome (shell, details card, preview, repeat
 *  field, buttons). "light" is the white card the form has always been in every theme;
 *  "theme" is the app's surface tokens — what CreateTaskDialog's Modal and `Input` use —
 *  and is only picked while the app is in dark mode (NewMeetingDialog), so light mode
 *  keeps the exact classes below. The pickers, chips and clock have their own maps
 *  (pickerTone.ts, SelectionField, TimePicker) and take the same two tone names. */
export interface MeetingClasses {
  panel: string;
  title: string;
  close: string;
  card: string;
  previewCard: string;
  divider: string;
  heading: string;
  label: string;
  strong: string;
  body: string;
  muted: string;
  /** A text/date/number/select field. */
  control: string;
  cancel: string;
  dayOff: string;
}

export const MEETING_TONES: Record<PickerTone, MeetingClasses> = {
  light: {
    panel: "border-gray-200 bg-white shadow-lg",
    title: "text-gray-900",
    close: "text-gray-400 hover:bg-gray-100 hover:text-gray-600",
    card: "border-gray-200 bg-white",
    previewCard: "border-gray-200 bg-gray-50",
    divider: "border-gray-200",
    heading: "text-gray-500",
    label: "text-gray-700",
    strong: "text-gray-900",
    body: "text-gray-700",
    muted: "text-gray-500",
    control:
      "border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent",
    cancel: "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
    dayOff: "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
  },
  theme: {
    // color-scheme: dark on the panel so native bits inside it (date picker icon,
    // select popups, scrollbar) render dark too.
    panel: "border-border bg-surface shadow-card [color-scheme:dark]",
    title: "text-fg",
    close: "text-muted hover:bg-surface-2 hover:text-fg",
    card: "border-border bg-surface",
    previewCard: "border-border bg-surface-2",
    divider: "border-border",
    heading: "text-muted",
    label: "text-fg/80",
    strong: "text-fg",
    body: "text-fg/80",
    muted: "text-muted",
    control:
      "border-border bg-surface text-fg placeholder:text-muted/70 focus:border-accent focus:ring-2 focus:ring-accent/25",
    cancel: "border-border bg-surface text-fg hover:bg-surface-2",
    dayOff: "border-border bg-surface-2 text-muted hover:bg-surface hover:text-fg",
  },
};
