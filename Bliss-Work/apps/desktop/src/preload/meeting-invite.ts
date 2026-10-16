import { contextBridge, ipcRenderer } from "electron";
import type { MeetingInvite } from "../main/meeting-invite-manager";

const params = new URLSearchParams(location.search);

/** Meeting-invite popup preload. Display-only, same shape as sticky.ts:
 *  receives its invite (from the URL at first paint, then live updates as
 *  main/meeting-invite-manager.ts's `show()` refreshes the same window with a
 *  resolved organizer — see IncomingMeetingNotice's two-phase call), emits
 *  one of three action intents. */
const api = {
  callId: params.get("callId") ?? "",
  title: params.get("title") ?? "",
  organizer: params.get("organizer") ?? "",
  adhoc: params.get("adhoc") === "1",

  /** Main pushed a refreshed title/organizer for the SAME callId — see
   *  MeetingInviteManager.show()'s early-return branch. */
  onUpdate: (cb: (invite: MeetingInvite) => void) => {
    const handler = (_: unknown, invite: MeetingInvite) => cb(invite);
    ipcRenderer.on("meeting-invite:update", handler);
    return () => ipcRenderer.removeListener("meeting-invite:update", handler);
  },

  /** Tell main this popup's renderer has registered its "meeting-invite:
   *  update" listener and is ready to receive one. Main responds by
   *  re-pushing the latest invite (MeetingInviteManager.onRendererReady), so
   *  an update sent before this listener existed — the organizer resolving
   *  between IncomingMeetingNotice's two show() calls — is not lost. Same
   *  handshake as sticky.ts's own `ready()`. */
  ready: () => ipcRenderer.send("meeting-invite:ready", api.callId),

  /** Video / Voice joins the call and closes the popup; Leave only closes it;
   *  Decline (ad-hoc rings only — see meeting-invite.tsx) also tells the
   *  server "no" via the main window before closing. */
  act: (action: "video" | "voice" | "leave" | "decline") =>
    ipcRenderer.send("meeting-invite:act", { callId: api.callId, action }),
};

contextBridge.exposeInMainWorld("meetingInvite", api);
export type MeetingInvitePreload = typeof api;
