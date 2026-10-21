import { contextBridge, ipcRenderer } from "electron";
import type { StickyTaskDTO } from "@taskboard/shared";

/** The carousel payload pushed from main on every reconcile/navigate: the
 *  whole floating set plus which entry is currently shown. */
export interface StickyTasksPayload {
  tasks: StickyTaskDTO[];
  index: number;
}

/**
 * Sticky-widget preload. Display-only: receives the carousel state, emits
 * action/navigation intents.
 *
 * Unlike the old per-task note, this window is not bound to one taskId — it
 * carries the whole pinned-and-floating set, so every call that used to read
 * an id off the URL now takes it explicitly from the renderer's current page.
 */
const api = {
  /** Whether the note should paint collapsed (as a pill) on first load —
   *  restored from persisted geometry by the main process via the URL. */
  collapsed: new URLSearchParams(location.search).get("collapsed") === "1",

  onTasks: (cb: (payload: StickyTasksPayload) => void) => {
    const handler = (_: unknown, payload: StickyTasksPayload) => cb(payload);
    ipcRenderer.on("sticky:tasks", handler);
    return () => ipcRenderer.removeListener("sticky:tasks", handler);
  },

  /** Tell main this window's renderer has registered its "sticky:tasks"
   *  listener and is ready to receive the carousel. Main responds by
   *  (re)pushing it. Main also pushes once on did-finish-load, but that can
   *  fire BEFORE the React effect subscribes — dropping the one-shot push and
   *  stranding the note on "Loading…". This handshake closes that race. */
  ready: () => ipcRenderer.send("sticky:ready"),

  /** action is a REST verb: acknowledge | complete | ignore | leave. On a
   *  locked note only "complete" is ever sent. */
  act: (taskId: string, action: string) => ipcRenderer.send("task:intent", { taskId, action }),

  /** Page the carousel to the next / previous pinned task, wrapping around. */
  next: () => ipcRenderer.send("sticky:next"),
  prev: () => ipcRenderer.send("sticky:prev"),

  /** Collapse the container to a pill / expand it back; main resizes the window. */
  setCollapsed: (collapsed: boolean) => ipcRenderer.send("sticky:collapse", { collapsed }),

  /** True where main cannot let the OS move/resize the note (Linux — see
   *  main/sticky-resize.ts), so the renderer draws the resize handles and starts
   *  body drags itself. */
  manualResize: process.platform === "linux",

  /** False only on Linux: the native window there stays opaque (see
   *  main/windows.ts's `transparent` option) because a non-compositing window
   *  manager paints a transparent frameless window as a solid block instead.
   *  Everywhere else the window is genuinely see-through, so the renderer's
   *  water-glass board shows the real desktop behind it; on Linux it still
   *  applies the same glass CSS, but over the opaque fallback colour sent via
   *  setBackgroundColor instead of the actual desktop. */
  nativeTransparency: process.platform !== "linux",

  /** A resize handle or the note body ("move") was pressed / released; main
   *  follows the cursor in between. */
  dragStart: (drag: string) => ipcRenderer.send("sticky:drag-start", { drag }),
  dragEnd: () => ipcRenderer.send("sticky:drag-end"),

  /** Linux only (see `nativeTransparency` above): the window there is opaque,
   *  not transparent, so its native background has to be told what colour to
   *  be — it can't just inherit whatever CSS variable the theme resolves to.
   *  Sent as a resolved `#rrggbb` hex string (read off the DOM and converted,
   *  never a raw theme token — see sticky.tsx's toHex) whenever the active
   *  theme changes, so the rounded-corner cutouts around the card stay
   *  matched instead of showing a stale colour. Never called where the
   *  window is natively transparent. */
  setBackgroundColor: (color: string) => ipcRenderer.send("sticky:bg", { color }),

  /** Unpin the given task from the desktop popup. Distinct from
   *  `act(taskId, "ignore")` — that is a decision about the TASK; this is only
   *  about the note, and the task keeps its status. Persisted: the task is not
   *  auto-pinned again, across server pushes and restarts. */
  unpin: (taskId: string) => ipcRenderer.send("sticky:unpin", taskId),

  /** Open this task's chat discussion. The sticky window has no router of its
   *  own, so this asks main to focus/show the main window and tell IT to open
   *  the discussion — see main/task-chat-open.ts. */
  openChat: (taskId: string) => ipcRenderer.send("sticky:open-chat", taskId),

  /** Task comments, relayed through ws-process — the one process that already
   *  holds an authenticated ApiClient (see main/index.ts's requestComments and
   *  ws-process.ts's "comments" case). This window has neither a RuntimeProvider
   *  nor its own API client, so every call round-trips through main instead of
   *  hitting task-svc directly. Each returns the same TaskCommentPage/
   *  TaskCommentDTO shape the main window's ApiClient methods do. */
  comments: {
    list: (taskId: string, cursor: string | null, limit: number) =>
      ipcRenderer.invoke("sticky:comments-list", taskId, cursor, limit),
    post: (taskId: string, body: string) => ipcRenderer.invoke("sticky:comments-post", taskId, body),
    replies: (taskId: string, commentId: string, cursor: string | null, limit: number) =>
      ipcRenderer.invoke("sticky:comments-replies", taskId, commentId, cursor, limit),
    postReply: (taskId: string, commentId: string, body: string) =>
      ipcRenderer.invoke("sticky:comments-reply-post", taskId, commentId, body),
  },
};

contextBridge.exposeInMainWorld("sticky", api);
export type StickyPreload = typeof api;
