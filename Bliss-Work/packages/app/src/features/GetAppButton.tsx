import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Monitor, Apple } from "lucide-react";
import { IconButton, cn } from "@taskboard/ui";
import { AnchoredPopover } from "./AnchoredPopover";
import { useRuntime } from "../lib/runtime";
import { PLATFORMS, PLATFORM_ORDER, detectPlatform, type PlatformId } from "../lib/downloads";
import { usePopupDismiss } from "../lib/usePopupDismiss";

/**
 * "Get the App" desktop-download control for the WEB app (communication.rnrtechs.com).
 *
 * Renders NOTHING in the Electron desktop build — a user already running the
 * desktop app doesn't need to download it (gated on config.kind === "web").
 *
 * Every link points at our own VPS (`/downloads/...`, served by nginx) via
 * lib/downloads — never GitHub — so a click downloads the installer straight
 * from our server.
 *
 *  • mode="inline"  → the login / onboarding card: a labelled row of the three
 *    OS installers, with the visitor's detected OS highlighted.
 *  • mode="compact" → the app top-navbar: an icon-only download button (tooltip
 *    "Get App") that opens a menu of the three platforms.
 */
const OsIcon = ({ id, size = 15 }: { id: PlatformId; size?: number }) =>
  id === "mac" ? <Apple size={size} /> : <Monitor size={size} />;

export function GetAppButton({
  mode = "compact",
  className,
}: {
  mode?: "compact" | "inline";
  className?: string;
}) {
  const { t } = useTranslation("shell");
  const { config } = useRuntime();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, close, [panelRef]);

  // Desktop users already have the app — never show it there.
  if (config.kind !== "web") return null;

  const detected = detectPlatform();

  if (mode === "inline") {
    return (
      <div className={cn("w-full", className)}>
        <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-muted">
          <span className="h-px flex-1 bg-border" />
          <span className="inline-flex items-center gap-1.5">
            <Download size={13} /> {t("getAppButton.getDesktopApp")}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PLATFORM_ORDER.map((id) => {
            const p = PLATFORMS[id];
            const recommended = detected === id;
            return (
              <a
                key={id}
                href={p.primary.url}
                download
                title={t("getAppButton.downloadForPlatform", {
                  brand: "BlissWork",
                  platform: p.name,
                  requirement: t(`getAppButton.requirement.${id}`),
                })}
                className={cn(
                  "group flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-colors",
                  recommended
                    ? "border-accent/60 bg-accent-soft text-accent ring-1 ring-accent/25"
                    : "border-border bg-surface/60 text-fg hover:border-muted/40 hover:bg-surface-2",
                )}
              >
                <OsIcon id={id} size={18} />
                <span className="text-xs font-semibold leading-none">{p.name}</span>
                <span className="text-[10px] leading-none text-muted">{p.primary.ext}</span>
              </a>
            );
          })}
        </div>
      </div>
    );
  }

  // compact — navbar dropdown
  return (
    <div ref={wrap} className={cn("relative", className)}>
      <IconButton
        tone="soft"
        onClick={() => setOpen((v) => !v)}
        title={t("getAppButton.getApp")}
        aria-label={t("getAppButton.getApp")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download size={18} />
      </IconButton>
      {open && (
        // usePopupDismiss handles outside clicks, Escape, and closing whatever
        // other popup was open — see lib/usePopupDismiss for why the old
        // click-away backdrop div is gone.
        <AnchoredPopover
          anchor={wrap}
          panelRef={panelRef}
          gap={6}
          role="menu"
          className="w-60 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          <p className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("getAppButton.downloadHeading", { brand: "BlissWork" })}
          </p>
          {PLATFORM_ORDER.map((id) => {
            const p = PLATFORMS[id];
            return (
              <a
                key={id}
                href={p.primary.url}
                download
                onClick={() => setOpen(false)}
                role="menuitem"
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg transition-colors hover:bg-surface-2",
                  detected === id && "text-accent",
                )}
              >
                <OsIcon id={id} />
                <span className="flex-1 font-medium">{p.name}</span>
                <span className="text-xs text-muted">{p.primary.ext}</span>
              </a>
            );
          })}
        </AnchoredPopover>
      )}
    </div>
  );
}
