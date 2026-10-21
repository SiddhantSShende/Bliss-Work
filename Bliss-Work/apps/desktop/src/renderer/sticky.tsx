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
  type ThemeId,
  type CustomTheme,
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

/** The light-mode counterpart of any ThemeId — "rose-dark" → "rose", "rose" →
 *  "rose" — i.e. the inverse of darkCounterpart, kept local since callers here
 *  only ever need the light half (see resolveBoardAccent). */
function lightCounterpart(id: ThemeId): ThemeId {
  return (id.endsWith("-dark") ? id.slice(0, -"-dark".length) : id) as ThemeId;
}

/** Resolve the board's colour as the Complete button's own accent token
 *  (`bg-accent` / `--color-accent`), NOT the button's brand-gradient stops —
 *  the gradient is a presentational flourish on the button itself and
 *  (unlike the accent token) isn't guaranteed stable across light/dark.
 *  Resolved off a DETACHED probe carrying the current family/custom theme
 *  forced to its LIGHT half, so the board stays the same colour whether the
 *  user is in light or dark mode — only switching the accent family (or a
 *  custom theme's colours) changes it. Never touches `document.documentElement`,
 *  so the real card (StickyWidget) keeps resolving its own light/dark colours
 *  completely independently. */
function resolveBoardAccentHex(themeId: ThemeId, custom: CustomTheme | null): string {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  applyTheme(probe, lightCounterpart(themeId), custom);
  probe.classList.add("bg-accent");
  const resolved = getComputedStyle(probe).backgroundColor;
  document.body.removeChild(probe);
  return toHex(resolved);
}

/** Apply the persisted theme on the sticky window's <html> so the note's
 *  surface/fg/border colours match the main app rather than being stuck on
 *  one preset. localStorage is shared across same-origin BrowserWindows in
 *  Electron (both windows load from the same dev server / file scheme), so
 *  the main app's ThemeProvider writes to "tb-theme" and the sticky reads it
 *  here. The `storage` event fires when the main window toggles theme, so a
 *  user clicking "Dark mode" in the menu instantly recolours every floating
 *  note without any IPC plumbing.
 *
 *  Returns the resolved board-accent hex so the caller can paint it onto the
 *  window body too (see StickyApp) — the colour behind/around the card and
 *  the nav arrows, Layer 1 in the two-layer model (Layer 2 is the card
 *  itself, which keeps following light/dark normally via the classes this
 *  applies to <html>). */
function useSyncedTheme(): string {
  const [boardAccent, setBoardAccent] = useState("#ffffff");
  useEffect(() => {
    const apply = () => {
      const stored = localStorage.getItem("tb-theme");
      const themeId = stored && isThemeId(stored) ? stored : defaultThemeFor(false);
      const custom = readStoredCustomTheme();
      const activeCustom = custom && isCustomThemeActive() ? custom : null;
      applyTheme(document.documentElement, themeId, activeCustom);

      // The OS window is opaque, not transparent (see windows.ts), so its
      // native background is a fixed colour main doesn't otherwise know —
      // it has to be told. Read the RESOLVED colour off a throwaway element
      // (never the raw CSS token, which could be oklch()/hex/anything and
      // isn't what setBackgroundColor accepts) so this works for every theme
      // family without hardcoding any of their values here. This is now the
      // SAME board-accent colour CSS paints behind the card (see below), so
      // the native window background and the painted board never mismatch
      // during a resize or before the page has painted.
      const accentHex = resolveBoardAccentHex(themeId, activeCustom);
      setBoardAccent(accentHex);
      window.sticky.setBackgroundColor(accentHex);
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
  return boardAccent;
}

function StickyApp() {
  const boardAccent = useSyncedTheme();
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
    // nav-arrow buttons below) sits directly on this div, now painted with
    // the Complete button's own accent colour (useSyncedTheme/
    // resolveBoardAccentHex) instead of the page background. The card itself
    // (StickyWidget, Layer 2) keeps resolving its own light/dark surface
    // completely independently of this.
    <div {...moveProps} className="flex h-full items-stretch p-1" style={{ backgroundColor: boardAccent }}>
      {resizeHandles}
      {/* w-4, no gap: every pixel here comes straight out of the card's own
          width budget (see windows.ts's FULL_W/minWidth, sized to compensate),
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
