import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StickyWidget, type StickyTaskDTO, type TaskAction } from "@taskboard/app";
import { isThemeId, themeClasses, ALL_THEME_CLASSES } from "@taskboard/ui";
import { Pin, Maximize2 } from "lucide-react";
import "@taskboard/ui/styles.css";
import "./index.css";

declare global {
  interface Window {
    sticky: {
      taskId: string;
      collapsed: boolean;
      onTask: (cb: (t: StickyTaskDTO) => void) => () => void;
      act: (taskId: string, action: string) => void;
      setCollapsed: (collapsed: boolean) => void;
      setBackgroundColor: (color: string) => void;
      ready: () => void;
      dismiss: () => void;
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

/** Apply the persisted theme on the sticky window's <html> so the note's
 *  surface/fg/border colours match the main app rather than being stuck on
 *  one preset. localStorage is shared across same-origin BrowserWindows in
 *  Electron (both windows load from the same dev server / file scheme), so
 *  the main app's ThemeProvider writes to "tb-theme" and the sticky reads it
 *  here. The `storage` event fires when the main window toggles theme, so a
 *  user clicking "Dark mode" in the menu instantly recolours every floating
 *  note without any IPC plumbing. */
function useSyncedTheme(): void {
  useEffect(() => {
    const apply = () => {
      const stored = localStorage.getItem("tb-theme");
      const classes = themeClasses(stored && isThemeId(stored) ? stored : "blue");
      const root = document.documentElement;
      root.classList.remove(...ALL_THEME_CLASSES);
      root.classList.add(...classes);
      // The OS window is opaque, not transparent (see windows.ts), so its
      // native background is a fixed colour main doesn't otherwise know —
      // it has to be told. Read the RESOLVED colour off a throwaway element
      // (never the raw --color-surface token, which could be oklch()/hex/
      // anything and isn't what setBackgroundColor accepts) so this works for
      // every theme family without hardcoding any of their values here.
      const probe = document.createElement("div");
      probe.className = "bg-surface";
      probe.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      document.body.removeChild(probe);
      window.sticky.setBackgroundColor(toHex(resolved));
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
}

function StickyApp() {
  useSyncedTheme();
  const [task, setTask] = useState<StickyTaskDTO | null>(null);
  // Initial collapsed state comes from main (restored from persisted geometry).
  const [collapsed, setCollapsed] = useState(window.sticky.collapsed);

  useEffect(() => {
    const off = window.sticky.onTask(setTask);
    // Signal readiness ONLY after the listener above is registered, so main
    // re-pushes the task even if its did-finish-load push already fired (and
    // was dropped) before this effect ran. Without this the note can hang on
    // "Loading…" forever after acknowledge.
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

  // Collapsed pill: a small always-on-top bubble. It can be expanded again but
  // never dismissed — only completing the task removes the note entirely.
  if (collapsed) {
    return (
      <div className="app-drag flex h-full items-center gap-2 rounded-2xl border border-border bg-surface px-3 shadow-widget">
        <Pin size={15} className="shrink-0 text-accent" />
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium ${task ? "text-fg" : "text-muted"}`}
        >
          {task ? task.title : "Loading…"}
        </span>
        <button
          className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
          title="Expand"
          onClick={expand}
        >
          <Maximize2 size={15} />
        </button>
      </div>
    );
  }

  if (!task)
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        Loading…
      </div>
    );

  // SENT → unlocked note with ✓ Acknowledge / ✗ Ignore. Once acknowledged it
  // locks to Complete-only (the commitment marker) — same workflow as before.
  return (
    <div className="h-full p-1.5">
      <StickyWidget
        task={task}
        compact
        locked={task.myStatus === "ACKNOWLEDGED"}
        onCollapse={collapse}
        onDismiss={() => window.sticky.dismiss()}
        onAction={(action: TaskAction) => window.sticky.act(task.taskId, VERB[action])}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StickyApp />
  </React.StrictMode>,
);
