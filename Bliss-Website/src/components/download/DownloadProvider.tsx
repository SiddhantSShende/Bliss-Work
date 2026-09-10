import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, X, ShieldCheck, ChevronRight } from "lucide-react";
import {
  PLATFORMS,
  PLATFORM_ORDER,
  detectPlatform,
  isMobileVisitor,
  ALL_RELEASES_URL,
  type PlatformId,
} from "@/config/downloads";
import { OsGlyph } from "@/components/brand/OsGlyph";
import { Logo } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";

const DownloadCtx = createContext<{ open: () => void; close: () => void; getApp: () => void }>({
  open: () => {},
  close: () => {},
  getApp: () => {},
});

export const useDownload = () => useContext(DownloadCtx);

/** Programmatically start a file download from our own VPS (`/downloads/...`),
 *  no navigation to GitHub. Uses a transient <a download> click. */
function startDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = ""; // honour the server filename; hints "download" not "navigate"
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  // Primary "Get the App" action: DIRECTLY download the installer for the
  // visitor's detected OS (Windows → .exe, macOS → .dmg, Linux → .AppImage) —
  // straight from our server, no GitHub, no extra click. If the OS can't be
  // detected we fall back to the platform-picker modal so the user can choose.
  const getApp = useCallback(() => {
    const id = detectPlatform();
    if (!id) {
      setOpen(true);
      return;
    }
    startDownload(PLATFORMS[id].primary.url);
  }, []);

  const value = useMemo(() => ({ open, close, getApp }), [open, close, getApp]);

  return (
    <DownloadCtx.Provider value={value}>
      {children}
      <DownloadModal open={isOpen} onClose={close} />
    </DownloadCtx.Provider>
  );
}

function DownloadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [detected, setDetected] = useState<PlatformId | null>(null);
  const [onMobile, setOnMobile] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDetected(detectPlatform());
    setOnMobile(isMobileVisitor());
  }, [open]);

  // Close on Escape + lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // Focus management: aria-modal="true" below promises assistive tech that
  // background content is inert, so keyboard focus has to actually stay
  // confined to the dialog while it's open — otherwise Tab keeps walking the
  // fixed Navbar and the rest of the page behind the overlay. Moves focus in
  // on open, traps Tab/Shift+Tab at the dialog's edges, and hands focus back
  // to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    (focusable()[0] ?? dialog).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);

    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Download BlissWork"
            tabIndex={-1}
            className="relative z-10 w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-surface shadow-card"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
          >
            {/* header */}
            <div className="relative flex items-center gap-3 border-b border-border/70 p-5 sm:p-6">
              <span className="brand-mesh absolute inset-0 -z-10 opacity-60" aria-hidden />
              <Logo size={36} />
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold tracking-tight text-fg">Get BlissWork</h3>
                <p className="text-sm text-muted">
                  {onMobile
                    ? "There's no mobile app yet — the installers below are for desktop."
                    : "Choose your platform — free to install."}
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <X size={18} />
              </button>
            </div>

            {/* platform cards */}
            <div className="grid gap-3 p-5 sm:grid-cols-3 sm:p-6">
              {PLATFORM_ORDER.map((id) => (
                <PlatformCard key={id} id={id} recommended={detected === id} />
              ))}
            </div>

            {/* footer note */}
            <div className="flex flex-col gap-2 border-t border-border/70 px-5 py-4 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-success" />
                First launch may warn "unknown publisher" — that's expected.{" "}
                <a
                  href="/downloads/SHA256SUMS.txt"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  Verify checksums
                </a>
              </span>
              {ALL_RELEASES_URL && (
                <a
                  href={ALL_RELEASES_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                >
                  All versions & release notes
                  <ChevronRight size={13} />
                </a>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PlatformCard({ id, recommended }: { id: PlatformId; recommended: boolean }) {
  const p = PLATFORMS[id];
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border bg-surface-2/50 p-4 transition-colors",
        recommended ? "border-accent/60 ring-1 ring-accent/30" : "border-border hover:border-muted/40",
      )}
    >
      {recommended && (
        <span className="absolute -top-2 right-3 rounded-full bg-gradient-to-br from-brand-from to-brand-to px-2 py-0.5 text-[10px] font-semibold text-accent-fg shadow-soft">
          Detected
        </span>
      )}
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <OsGlyph os={id} size={22} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold tracking-tight text-fg">{p.name}</p>
          <p className="truncate text-[11px] text-muted">{p.requirement}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-1 flex-col justify-end gap-1.5">
        {p.assets.map((a, i) => (
          <a
            key={a.url}
            href={a.url}
            download
            className={cn(
              "group inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all",
              i === 0
                ? "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_6px_18px_-8px_var(--color-accent)] hover:-translate-y-0.5 hover:brightness-105"
                : "border border-border text-fg hover:bg-surface-2",
            )}
          >
            <Download size={14} />
            {a.label}
          </a>
        ))}
      </div>
    </div>
  );
}
