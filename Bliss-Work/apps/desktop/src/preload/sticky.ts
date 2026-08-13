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
};

contextBridge.exposeInMainWorld("sticky", api);
export type StickyPreload = typeof api;
