import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StickyWidget, type StickyTaskDTO, type TaskAction } from "@taskboard/app";
import { followStoredLocale, useTranslation } from "@taskboard/app/i18n/windowLocale";
import {
  applyTheme,
  isCustomThemeActive,
  isThemeId,
  readStoredCustomTheme,
  defaultThemeFor,
} from "@taskboard/ui";
import { Pin, Maximize2, ChevronLeft, ChevronRight } from "lucide-react";
import "@taskboard/ui/styles.css";
import "./index.css";
import { StickyResizeHandles, useManualMove } from "./StickyResizeHandles";

interface StickyTasksPayload {
  tasks: StickyTaskDTO[];
  index: number;
}

declare global {
  interface Window {
    sticky: {
      collapsed: boolean;
      manualResize: boolean;
      dragStart: (drag: string) => void;
      dragEnd: () => void;
      onTasks: (cb: (payload: StickyTasksPayload) => void) => () => void;
      act: (taskId: string, action: string) => void;
      next: () => void;
      prev: () => void;
      setCollapsed: (collapsed: boolean) => void;
      setBackgroundColor: (color: string) => void;
      nativeTransparency: boolean;
      ready: () => void;
      unpin: (taskId: string) => void;
      openChat: (taskId: string) => void;
      comments: {
        list: (taskId: string, cursor: string | null, limit: number) => Promise<unknown>;
        post: (taskId: string, body: string) => Promise<unknown>;
        replies: (taskId: string, commentId: string, cursor: string | null, limit: number) => Promise<unknown>;
        postReply: (taskId: string, commentId: string, body: string) => Promise<unknown>;
      };
    };
  }
}

const VERB: Record<TaskAction, string> = {
  ACKNOWLEDGE: "acknowledge",
  COMPLETE: "complete",
  IGNORE: "ignore",
  LEAVE: "leave",
};

/** `getComputedStyle` always resolves to `rgb(...)`/`rgba(...)`, regardless
 *  of how the colour was authored (oklch/hex/named) — but `setBackgroundColor`
 *  is only documented to accept hex, so convert rather than pass the resolved
 *  form straight through. Falls back to white on a shape it doesn't
 *  recognise; a wrong-but-valid colour is a cosmetic corner, never worth
 *  more than that. */
function toHex(resolved: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(resolved);
  if (!m) return "#ffffff";
  const [, r, g, b] = m;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`;
}

/** The board's water-glass surface, independent of accent colour: a faint
 *  tint (white in light mode, near-black in dark mode) plus a blur, so the
 *  real desktop behind the window reads through while staying readable
 *  whatever wallpaper sits behind it. Picked off `themeId` alone — never the
 *  accent family/custom theme — so switching the accent colour never changes
 *  the board, only light/dark does. */
const GLASS_SURFACE = {
  light: {
    background: "linear-gradient(155deg, rgba(255,255,255,0.30), rgba(255,255,255,0.12))",
    border: "1px solid rgba(255,255,255,0.45)",
  },
  dark: {
    background: "linear-gradient(155deg, rgba(20,20,26,0.38), rgba(20,20,26,0.20))",
    border: "1px solid rgba(255,255,255,0.10)",
  },
} as const;

/** Apply the persisted theme on the sticky window's <html> so the note's
 *  surface/fg/border colours match the main app rather than being stuck on
 *  one preset. localStorage is shared across same-origin BrowserWindows in
 *  Electron (both windows load from the same dev server / file scheme), so
 *  the main app's ThemeProvider writes to "tb-theme" and the sticky reads it
 *  here. The `storage` event fires when the main window toggles theme, so a
 *  user clicking "Dark mode" in the menu instantly recolours every floating
 *  note without any IPC plumbing.
 *
 *  Returns which glass surface (light/dark) the board should paint, Layer 1
 *  in the two-layer model — Layer 2 is the card itself (StickyWidget), which
 *  keeps following light/dark normally via the classes this applies to
 *  <html>, completely independently of the board. */
function useSyncedTheme(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">("light");
  useEffect(() => {
    const apply = () => {
      const stored = localStorage.getItem("tb-theme");
      const themeId = stored && isThemeId(stored) ? stored : defaultThemeFor(false);
      const custom = readStoredCustomTheme();
      const activeCustom = custom && isCustomThemeActive() ? custom : null;
      applyTheme(document.documentElement, themeId, activeCustom);
      setMode(themeId.endsWith("-dark") ? "dark" : "light");

      // Only Linux keeps an opaque native window (see windows.ts) — its
      // native background is a fixed colour main doesn't otherwise know, so
      // it has to be told. This paints it with the plain page background
      // (never the accent token), read off a throwaway probe so it works for
      // every theme family without hardcoding any of their values here. On
      // Windows/macOS the window is natively transparent, so this is skipped
      // entirely — there is no native fallback colour to keep in sync.
      if (!window.sticky.nativeTransparency) {
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;";
        document.body.appendChild(probe);
        probe.classList.add("bg-bg");
        const pageBgHex = toHex(getComputedStyle(probe).backgroundColor);
        document.body.removeChild(probe);
        window.sticky.setBackgroundColor(pageBgHex);
      }
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
  return mode;
}

function StickyApp() {
  const mode = useSyncedTheme();
  const glass = GLASS_SURFACE[mode];
  const moveProps = useManualMove();
  const { t } = useTranslation("stickies");
  useEffect(() => {
    document.title = t("window.titles.task");
  }, [t]);
  // The whole floating set + which page is shown — one shared window carries
  // every pinned task now, instead of one window per task.
  const [payload, setPayload] = useState<StickyTasksPayload>({ tasks: [], index: 0 });
  // Initial collapsed state comes from main (restored from persisted geometry).
  const [collapsed, setCollapsed] = useState(window.sticky.collapsed);

  useEffect(() => {
    const off = window.sticky.onTasks(setPayload);
    // Signal readiness ONLY after the listener above is registered, so main
    // re-pushes the carousel even if its did-finish-load push already fired
    // (and was dropped) before this effect ran. Without this the note can
    // hang on "Loading…" forever after acknowledge.
    window.sticky.ready();
    return off;
  }, []);

  const collapse = () => {
    setCollapsed(true);
    window.sticky.setCollapsed(true);
  };
  const expand = () => {
    setCollapsed(false);
    window.sticky.setCollapsed(false);
  };

  const task = payload.tasks[payload.index] ?? null;
  const hasMultiple = payload.tasks.length > 1;

  // Collapsed pill: a small always-on-top bubble. It can be expanded again;
  // expand it to reach Unpin.
  if (collapsed) {
    return (
      <div {...moveProps} className="app-drag flex h-full items-center gap-2 rounded-2xl border border-border bg-surface px-3 shadow-widget">
        <Pin size={15} className="shrink-0 text-accent" />
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium ${task ? "text-fg" : "text-muted"}`}
        >
          {task ? task.title : t("window.loading")}
        </span>
        <button
          className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
          title={t("window.expand")}
          onClick={expand}
        >
          <Maximize2 size={15} />
        </button>
      </div>
    );
  }

  // Linux only: the OS can't resize this window, so the note draws its own handles.
  const resizeHandles = window.sticky.manualResize ? <StickyResizeHandles /> : null;

  if (!task)
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        {t("window.loading")}
        {resizeHandles}
      </div>
    );

  // SENT → unlocked note with ✓ Acknowledge / ✗ Ignore. Once acknowledged it
  // locks to Complete-only (the commitment marker) — same workflow as before.
  //
  // The nav arrows are only rendered — not merely disabled — with one or
  // zero floating tasks, so a single pinned task looks exactly like the old
  // one-note widget, with no dead controls.
  return (
    // Layer 1 — the board: everything around the card (this padding, and the
    // nav-arrow buttons below) sits directly on this div, painted as a
    // translucent water-glass surface (useSyncedTheme/GLASS_SURFACE) rather
    // than any solid colour — on Windows/macOS the window itself is natively
    // transparent (see main/windows.ts), so the real desktop shows through;
    // on Linux the window stays opaque behind this (same platform limitation
    // that keeps resize manual there), so the blur/tint still applies but
    // over the native fallback colour, not the desktop. The card itself
    // (StickyWidget, Layer 2) keeps resolving its own light/dark surface
    // completely independently of this.
    <div
      {...moveProps}
      className="flex h-full items-stretch rounded-xl p-1"
      style={{ background: glass.background, border: glass.border, backdropFilter: "blur(18px) saturate(140%)" }}
    >
      {resizeHandles}
      {/* w-4, no gap: every pixel here comes straight out of the card's own
          width budget (see windows.ts's default width, sized to compensate),
          and the Acknowledge/Ignore row was already once broken by too little
          of it — see StickyWidget's doc comment. */}
      {hasMultiple && (
        <button
          className="app-no-drag flex w-4 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
          title={t("window.previousTask")}
          aria-label={t("window.previousTask")}
          onClick={() => window.sticky.prev()}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <StickyWidget
          task={task}
          compact
          locked={task.myStatus === "ACKNOWLEDGED"}
          onCollapse={collapse}
          onUnpin={() => window.sticky.unpin(task.taskId)}
          onAction={(action: TaskAction) => window.sticky.act(task.taskId, VERB[action])}
          onChat={() => window.sticky.openChat(task.taskId)}
        />
      </div>
      {hasMultiple && (
        <button
          className="app-no-drag flex w-4 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
          title={t("window.nextTask")}
          aria-label={t("window.nextTask")}
          onClick={() => window.sticky.next()}
        >
          <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}

// Follow the main window's language (shared localStorage); renders English until
// the catalog lands, then re-renders in place.
void followStoredLocale();

// CommentsPanel (rendered inside StickyWidget) uses react-query, which needs
// a QueryClient in context regardless of how its queryFn actually fetches —
// this window has no RuntimeProvider (see useTaskComments' IPC bridge path),
// but still needs this for the cache/mutation plumbing to work at all.
const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <StickyApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
