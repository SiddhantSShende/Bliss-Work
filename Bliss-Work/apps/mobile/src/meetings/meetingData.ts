import {
  CHAT_SYNC_MAX,
  NOTES_SYNC_MAX,
  mergeChat,
  mergeNotes,
  newChatEntry,
  newNoteEntry,
  unreadSince,
  visibleToMe,
  visibleToPeer,
  type ChatEntry,
  type NoteEntry,
  type RoomMessage,
} from './roomData';

/**
 * Live chat + shared notes for ONE meeting, over the meeting's existing
 * infrastructure — nothing local-only:
 *
 *  - live: the LiveKit data channel (same wire format as web, see roomData);
 *  - kept: our own entries are also POSTed to the meeting
 *    (`saveCallChat` / `saveCallNote`), exactly as web does, so they survive
 *    the call and appear in the meeting record. Room-wide only: a private
 *    message stays on the wire;
 *  - caught up: a newcomer asks the room (`chat-request` / `notes-request`)
 *    AND reads the stored transcript (`callChat` / `callNotes`), merging by id.
 *
 * Pure of React and native code (deps injected), so it is unit-tested.
 */

interface ChatRow { id: string; senderId: string; text: string; sentAt: string }
interface NoteRow { id: string; authorId: string; text: string; writtenAt: string }

export interface MeetingDataApi {
  saveCallChat(callId: string, e: { id: string; text: string; at: number }): Promise<unknown>;
  saveCallNote(callId: string, e: { id: string; text: string; at: number }): Promise<unknown>;
  callChat(callId: string, cursor?: string): Promise<{ items: ChatRow[]; nextCursor?: string | null }>;
  callNotes(callId: string, cursor?: string): Promise<{ items: NoteRow[]; nextCursor?: string | null }>;
}

export interface MeetingDataDeps {
  callId: string;
  /** Our room identity (= BlissWork user id). Undefined until known. */
  selfIdentity: () => string | undefined;
  selfName: () => string;
  /** Publish on the data channel; `to` = destination identities (private). */
  send: (msg: RoomMessage, to?: string[]) => void;
  onData: (cb: (m: RoomMessage, from: string) => void) => () => void;
  api: MeetingDataApi;
  /** Display name for a user id (directory/roster), when known. */
  nameOf?: (identity: string) => string | undefined;
  now?: () => number;
  /** Cap on history pages read from the server. */
  maxHistoryPages?: number;
  log?: (event: string, data?: Record<string, string | number | boolean | undefined>) => void;
}

export interface MeetingDataSnapshot {
  chat: ChatEntry[];
  notes: NoteEntry[];
  /** Chat messages from others since the panel was last looked at. */
  unread: number;
  /** Server history is still being read. */
  loadingHistory: boolean;
  /** Last send that could not be kept in the record (data channel still worked). */
  keepFailed: boolean;
}

type Listener = () => void;

export class MeetingData {
  private snap: MeetingDataSnapshot = { chat: [], notes: [], unread: 0, loadingHistory: false, keepFailed: false };
  private readonly listeners = new Set<Listener>();
  private off: (() => void) | undefined;
  private chatSeenAt = 0;
  private chatVisible = false;
  private disposed = false;

  constructor(private readonly d: MeetingDataDeps) { }

  getSnapshot = (): MeetingDataSnapshot => this.snap;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<MeetingDataSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  private recount(chat: ChatEntry[]) {
    const me = this.d.selfIdentity() ?? '';
    if (this.chatVisible) {
      // Being read as it arrives: keep the mark on the newest message.
      this.chatSeenAt = Math.max(this.chatSeenAt, chat.reduce((m, c) => Math.max(m, c.at), 0));
      return 0;
    }
    return unreadSince(chat, this.chatSeenAt, me);
  }

  /** Begin: listen, ask the room what we missed, and read the stored record. */
  start(): void {
    this.off = this.d.onData((m, from) => this.onMessage(m, from));
    this.d.send({ t: 'notes-request' });
    this.d.send({ t: 'chat-request' });
    void this.loadHistory();
  }

  dispose(): void {
    this.disposed = true;
    this.off?.();
    this.off = undefined;
    this.listeners.clear();
  }

  // ── history from the server ─────────────────────────────────────────────
  private nameOf(id: string): string {
    return this.d.nameOf?.(id) ?? id.slice(0, 8);
  }

  private async loadHistory(): Promise<void> {
    this.set({ loadingHistory: true });
    const max = this.d.maxHistoryPages ?? 3;
    try {
      let cursor: string | undefined;
      for (let i = 0; i < max && !this.disposed; i++) {
        const page = await this.d.api.callChat(this.d.callId, cursor);
        if (this.disposed) return;
        const rows: ChatEntry[] = page.items.map((r) => ({ id: r.id, from: r.senderId, fromName: this.nameOf(r.senderId), to: null, text: r.text, at: Date.parse(r.sentAt) }));
        const chat = mergeChat(this.snap.chat, rows);
        if (chat !== this.snap.chat) this.set({ chat, unread: this.recount(chat) });
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      cursor = undefined;
      for (let i = 0; i < max && !this.disposed; i++) {
        const page = await this.d.api.callNotes(this.d.callId, cursor);
        if (this.disposed) return;
        const rows: NoteEntry[] = page.items.map((r) => ({ id: r.id, author: this.nameOf(r.authorId), text: r.text, at: Date.parse(r.writtenAt) }));
        const notes = mergeNotes(this.snap.notes, rows);
        if (notes !== this.snap.notes) this.set({ notes });
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } catch (e) {
      // A deployment without the transcript, or offline: live data still works.
      this.d.log?.('meeting.history.failed', { error: e instanceof Error ? e.message : 'unknown' });
    } finally {
      if (!this.disposed) this.set({ loadingHistory: false });
    }
  }

  // ── inbound ──────────────────────────────────────────────────────────────
  private onMessage(m: RoomMessage, from: string): void {
    const me = this.d.selfIdentity();
    switch (m.t) {
      case 'chat': {
        if (!me || !visibleToMe(m.msg, me)) return;
        const chat = mergeChat(this.snap.chat, [m.msg]);
        if (chat !== this.snap.chat) this.set({ chat, unread: this.recount(chat) });
        return;
      }
      case 'chat-sync': {
        if (!me) return;
        const chat = mergeChat(this.snap.chat, m.msgs.filter((c) => visibleToMe(c, me)));
        if (chat !== this.snap.chat) this.set({ chat, unread: this.recount(chat) });
        return;
      }
      case 'chat-request': {
        // Only what was said to the room (or between us): never forward a
        // private exchange with somebody else.
        const held = this.snap.chat.filter((c) => visibleToPeer(c, from)).slice(-CHAT_SYNC_MAX);
        if (held.length) this.d.send({ t: 'chat-sync', msgs: held }, [from]);
        return;
      }
      case 'note': {
        const notes = mergeNotes(this.snap.notes, [m.note]);
        if (notes !== this.snap.notes) this.set({ notes });
        return;
      }
      case 'notes-sync': {
        const notes = mergeNotes(this.snap.notes, m.notes);
        if (notes !== this.snap.notes) this.set({ notes });
        return;
      }
      case 'notes-request': {
        const held = this.snap.notes.slice(-NOTES_SYNC_MAX);
        if (held.length) this.d.send({ t: 'notes-sync', notes: held }, [from]);
        return;
      }
      default:
        return;
    }
  }

  // ── outbound ─────────────────────────────────────────────────────────────
  /** Say something to the room, or to one person. Returns the entry, or null
   *  when there is nothing to send / we do not know who we are yet. */
  sendChat(text: string, to: string | null = null): ChatEntry | null {
    const me = this.d.selfIdentity();
    const body = text.trim();
    if (!me || !body) return null;
    const entry = newChatEntry({ from: me, fromName: this.d.selfName(), to, text: body, at: this.now() });
    const chat = mergeChat(this.snap.chat, [entry]);
    this.set({ chat, unread: this.recount(chat) });
    this.d.send({ t: 'chat', msg: entry }, to ? [to] : undefined);
    // Room-wide only: a private message stays on the wire, where its audience
    // is what the sender chose.
    if (to === null) this.keep('chat', entry);
    return entry;
  }

  addNote(text: string): NoteEntry | null {
    const me = this.d.selfIdentity();
    const body = text.trim();
    if (!me || !body) return null;
    const entry = newNoteEntry({ identity: me, author: this.d.selfName(), text: body, at: this.now() });
    this.set({ notes: mergeNotes(this.snap.notes, [entry]) });
    this.d.send({ t: 'note', note: entry });
    this.keep('note', entry);
    return entry;
  }

  /** Fire and forget: the meeting must not wait on, or break because of, the
   *  transcript write. The data channel already carried it to the room. */
  private keep(what: 'chat' | 'note', e: { id: string; text: string; at: number }): void {
    const save = what === 'chat' ? this.d.api.saveCallChat(this.d.callId, { id: e.id, text: e.text, at: e.at }) : this.d.api.saveCallNote(this.d.callId, { id: e.id, text: e.text, at: e.at });
    void save.then(
      () => {
        if (!this.disposed && this.snap.keepFailed) this.set({ keepFailed: false });
      },
      (err: unknown) => {
        this.d.log?.('meeting.keep.failed', { what, error: err instanceof Error ? err.message : 'unknown' });
        if (!this.disposed) this.set({ keepFailed: true });
      },
    );
  }

  /** The chat panel is (or is no longer) on screen: reading clears unread. */
  setChatVisible(visible: boolean): void {
    this.chatVisible = visible;
    // Everything up to the newest message (or now, if later) counts as seen —
    // on close too, so what arrived while the panel was open is not re-counted.
    const newest = this.snap.chat.reduce((m, c) => Math.max(m, c.at), 0);
    this.chatSeenAt = Math.max(this.now(), newest);
    if (this.snap.unread !== 0) this.set({ unread: 0 });
  }
}
