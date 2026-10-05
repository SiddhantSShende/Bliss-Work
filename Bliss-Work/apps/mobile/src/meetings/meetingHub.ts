import { MeetingData, type MeetingDataApi, type MeetingDataSnapshot } from './meetingData';
import { decodeRoomMessage, encodeRoomMessage, type RoomMessage } from './roomData';

/**
 * Owns the chat/notes state of the meeting that is currently live: creates a
 * `MeetingData` when a room connects and disposes it when the room ends, so
 * the UI has one stable place to read from and nothing survives into the next
 * meeting. No native imports; the room is reached through a small interface.
 */
export interface HubRoom {
  getSnapshot(): { phase: string; callId?: string };
  subscribe(l: () => void): () => void;
  sendData(bytes: Uint8Array, to?: string[]): void;
  onData(cb: (bytes: Uint8Array, from: string) => void): () => void;
}

export interface HubDeps {
  room: HubRoom;
  api: MeetingDataApi;
  selfIdentity: () => string | undefined;
  selfName: () => string;
  nameOf?: (identity: string) => string | undefined;
  log?: (event: string, data?: Record<string, string | number | boolean | undefined>) => void;
}

export const EMPTY_MEETING_DATA: MeetingDataSnapshot = { chat: [], notes: [], unread: 0, loadingHistory: false, keepFailed: false };

type Listener = () => void;

export class MeetingHub {
  private current: { callId: string; data: MeetingData; off: () => void } | null = null;
  private snap: MeetingDataSnapshot = EMPTY_MEETING_DATA;
  private readonly listeners = new Set<Listener>();
  private readonly offRoom: () => void;

  constructor(private readonly d: HubDeps) {
    this.offRoom = d.room.subscribe(() => this.sync());
    this.sync();
  }

  getSnapshot = (): MeetingDataSnapshot => this.snap;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private publish(next: MeetingDataSnapshot) {
    if (next === this.snap) return;
    this.snap = next;
    for (const l of this.listeners) l();
  }

  private sync(): void {
    const { phase, callId } = this.d.room.getSnapshot();
    const live = (phase === 'connected' || phase === 'reconnecting') && !!callId;
    if (this.current && (!live || this.current.callId !== callId)) {
      this.teardown();
    }
    if (live && callId && !this.current) this.setup(callId);
  }

  private setup(callId: string): void {
    const data = new MeetingData({
      callId,
      selfIdentity: this.d.selfIdentity,
      selfName: this.d.selfName,
      nameOf: this.d.nameOf,
      api: this.d.api,
      log: this.d.log,
      send: (msg: RoomMessage, to?: string[]) => this.d.room.sendData(encodeRoomMessage(msg), to),
      onData: (cb) =>
        this.d.room.onData((bytes, from) => {
          const m = decodeRoomMessage(bytes);
          if (m) cb(m, from);
        }),
    });
    const off = data.subscribe(() => this.publish(data.getSnapshot()));
    this.current = { callId, data, off };
    data.start();
    this.publish(data.getSnapshot());
  }

  private teardown(): void {
    const cur = this.current;
    this.current = null;
    if (!cur) return;
    cur.off();
    cur.data.dispose();
    this.publish(EMPTY_MEETING_DATA);
  }

  // ── actions (no-ops when no meeting is live) ─────────────────────────────
  sendChat = (text: string, to: string | null = null) => this.current?.data.sendChat(text, to) ?? null;
  addNote = (text: string) => this.current?.data.addNote(text) ?? null;
  setChatVisible = (visible: boolean) => this.current?.data.setChatVisible(visible);

  dispose(): void {
    this.offRoom();
    this.teardown();
    this.listeners.clear();
  }
}
