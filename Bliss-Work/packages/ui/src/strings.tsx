import { createContext, useContext } from "react";

/**
 * The handful of words this package renders itself (default labels, chart
 * captions). `@taskboard/ui` stays free of any i18n library: the host app wraps
 * its tree in <UiStringsProvider> with translated values (see
 * packages/app/src/i18n/UiStringsBridge.tsx); without one, English is used.
 *
 * Per-call props (`backLabel`, `emptyHint`, …) still win over these defaults.
 */
export interface UiStrings {
  /** PageHeader back button label. */
  back: string;
  /** Avatar tooltip while the person is on a call. */
  onCall: string;
  /** RankedBars placeholder when there is nothing to rank. */
  nothingRecorded: string;
  /** BarChart accessible-label noun when no `valueLabel` is given. */
  chartValue: string;
  /** BarChart accessible label, e.g. "Active by day, peak 4h". */
  chartPeakAria: (value: string, peak: string) => string;
  /** BarChart bar tooltip suffix when a bar has idle context. */
  chartActiveIdle: (active: string, idle: string) => string;
}

export const DEFAULT_UI_STRINGS: UiStrings = {
  back: "Back",
  onCall: "On a call",
  nothingRecorded: "Nothing recorded in this period.",
  chartValue: "Value",
  chartPeakAria: (value, peak) => `${value} by day, peak ${peak}`,
  chartActiveIdle: (active, idle) => `${active} active, ${idle} idle`,
};

const UiStringsContext = createContext<UiStrings>(DEFAULT_UI_STRINGS);

export const UiStringsProvider = UiStringsContext.Provider;
export const useUiStrings = (): UiStrings => useContext(UiStringsContext);
