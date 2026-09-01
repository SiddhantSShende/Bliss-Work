import { contextBridge, ipcRenderer } from "electron";
import type { StickyTaskDTO } from "@taskboard/shared";

/** Sticky-widget preload. Display-only: receives its task, emits action intents. */
const api = {
  taskId: new URLSearchParams(location.search).get("taskId") ?? "",

  /** Whether the note should paint collapsed (as a pill) on first load —
   *  restored from persisted geometry by the main process via the URL. */
  collapsed: new URLSearchParams(location.search).get("collapsed") === "1",

  onTask: (cb: (t: StickyTaskDTO) => void) => {
    const handler = (_: unknown, t: StickyTaskDTO) => cb(t);
    ipcRenderer.on("sticky:task", handler);
    return () => ipcRenderer.removeListener("sticky:task", handler);
  },

  /** Tell main this note's renderer has registered its "sticky:task" listener
   *  and is ready to receive the task. Main responds by (re)pushing it. The
   *  main process also pushes once on did-finish-load, but that can fire BEFORE
   *  the React effect subscribes — dropping the one-shot push and stranding the
   *  note on "Loading…". This handshake closes that race. */
  ready: () => ipcRenderer.send("sticky:ready", api.taskId),

  /** action is a REST verb: acknowledge | complete | ignore | leave. On a
   *  locked note only "complete" is ever sent. */
  act: (taskId: string, action: string) => ipcRenderer.send("task:intent", { taskId, action }),

  /** Collapse this note to a pill / expand it back; main resizes the window. */
  setCollapsed: (collapsed: boolean) =>
    ipcRenderer.send("sticky:collapse", { taskId: api.taskId, collapsed }),

  /** The window is opaque, not transparent (see windows.ts), so its native
   *  background has to be told what colour to be — it can't just inherit
   *  whatever CSS variable the theme resolves to. Sent as a resolved `#rrggbb`
   *  hex string (read off the DOM and converted, never a raw theme token —
   *  see sticky.tsx's toHex) whenever the active theme changes, so the
   *  rounded-corner cutouts around the card stay matched instead of showing a
   *  stale colour. */
  setBackgroundColor: (color: string) =>
    ipcRenderer.send("sticky:bg", { taskId: api.taskId, color }),

  /** Take this note off screen for the rest of this run. Distinct from
   *  `act(…, "ignore")` — that is a decision about the TASK; this is only about
   *  the note, and the task keeps its status. NOT remembered across restarts:
   *  an outstanding task gets its note back on the next launch, and only
   *  completing or ignoring the task removes it for good. */
  dismiss: () => ipcRenderer.send("sticky:dismiss", api.taskId),
};

contextBridge.exposeInMainWorld("sticky", api);
export type StickyPreload = typeof api;
