import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UiStringsProvider, type UiStrings } from "@taskboard/ui";

/**
 * Hands `@taskboard/ui` its translated default labels (PageHeader's back button,
 * the on-a-call tooltip, chart captions). That package renders a few words of
 * its own and deliberately has no i18n dependency, so the app supplies them.
 */
export function UiStringsBridge({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("common");
  const strings = useMemo<UiStrings>(
    () => ({
      back: t("ui.back"),
      onCall: t("ui.onCall"),
      nothingRecorded: t("ui.nothingRecorded"),
      chartValue: t("ui.chartValue"),
      chartPeakAria: (value, peak) => t("ui.chartPeakAria", { value, peak }),
      chartActiveIdle: (active, idle) => t("ui.chartActiveIdle", { active, idle }),
    }),
    [t],
  );
  return <UiStringsProvider value={strings}>{children}</UiStringsProvider>;
}
