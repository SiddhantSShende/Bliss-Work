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

  /** Main pushed a refreshed title/organizer for the SAME callId — see
   *  MeetingInviteManager.show()'s early-return branch. */
  onUpdate: (cb: (invite: MeetingInvite) => void) => {
    const handler = (_: unknown, invite: MeetingInvite) => cb(invite);
    ipcRenderer.on("meeting-invite:update", handler);
    return () => ipcRenderer.removeListener("meeting-invite:update", handler);
  },

  /** Video / Voice joins the call and closes the popup; Leave only closes it. */
  act: (action: "video" | "voice" | "leave") =>
    ipcRenderer.send("meeting-invite:act", { callId: api.callId, action }),
};

contextBridge.exposeInMainWorld("meetingInvite", api);
export type MeetingInvitePreload = typeof api;
