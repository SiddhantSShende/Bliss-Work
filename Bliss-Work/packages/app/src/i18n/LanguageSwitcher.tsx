import { useState } from "react";
import { Globe, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@taskboard/ui";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { useLanguage } from "./LanguageProvider";

/**
 * Top-bar language switcher, immediately beside the notification bell — same
 * compact-menu shape as Settings' ThemeMenu (IconButton trigger +
 * usePopupDismiss for outside-click/Escape), so it reads as an established
 * control rather than a new one-off.
 */
export function LanguageSwitcher() {
  const { t } = useTranslation("common");
  const { locale, setLocale, availableLocales } = useLanguage();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, close);
  const current = availableLocales.find((l) => l.code === locale);

  return (
    <div ref={wrap} className="relative">
      <IconButton
        onClick={() => (open ? close() : setOpen(true))}
        title={t("language.switcherTitle", { name: current?.nativeName ?? locale })}
        aria-label={t("language.changeLanguage")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Globe size={18} />
      </IconButton>
      {open && (
        <div
          role="menu"
          aria-label={t("language.changeLanguage")}
          className="absolute right-0 z-[1000] mt-1.5 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-card"
        >
          {availableLocales.map((opt) => (
            <button
              key={opt.code}
              type="button"
              role="menuitemradio"
              aria-checked={opt.code === locale}
              onClick={() => {
                setLocale(opt.code);
                close();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{opt.nativeName}</span>
              {opt.code === locale && <Check size={16} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
