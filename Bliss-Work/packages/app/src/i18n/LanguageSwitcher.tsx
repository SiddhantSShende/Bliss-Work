import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Globe, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@taskboard/ui";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { usePopoverPosition } from "../lib/usePopoverPosition";
import { useLanguage } from "./LanguageProvider";

/**
 * Top-bar language switcher, immediately beside the notification bell —
 * IconButton trigger + usePopupDismiss for outside-click/Escape, same as
 * Settings' ThemeMenu. The panel itself is portalled and placed with
 * usePopoverPosition (same mechanism as EmojiPicker/TimePicker) instead of a
 * plain `absolute right-0`, because the trigger sits inside AppShell's
 * `overflow-hidden` root: a fixed-offset panel has no scroll fallback and
 * would get clipped rather than flipping above the trigger or scrolling
 * internally when there isn't room below.
 */
export function LanguageSwitcher() {
  const { t } = useTranslation("common");
  const { locale, setLocale, availableLocales } = useLanguage();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrap = usePopupDismiss<HTMLDivElement>(open, close, [panelRef]);
  const style = usePopoverPosition({ anchor: wrap, panelRef, align: "end", active: open });
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
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={t("language.changeLanguage")}
            style={style}
            className="fixed z-[1100] w-56 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-card"
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
          </div>,
          document.body,
        )}
    </div>
  );
}
