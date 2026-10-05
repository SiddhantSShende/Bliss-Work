import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, MessageCircle, Mic, MicOff, Search, Send, StickyNote, UserPlus, Users, Video as VideoIcon, VideoOff, X } from 'lucide-react-native';
import { ActivityIndicator, FlatList, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSession } from '@taskboard/app/store/session';
import { Avatar } from '../components/Avatar';
import { useMeetingData } from '../calls/CallProvider';
import { useCalls } from '../calls/CallProvider';
import type { RoomParticipantView } from '../calls/roomController';
import type { PendingInvitee } from '../calls/addPeople';
import { GlassPanel } from './Glass';
import { NOTE_TEXT_MAX, CHAT_TEXT_MAX, type ChatEntry, type NoteEntry } from './roomData';
import { useMeetingSkin } from './skin';

export type PanelTab = 'chat' | 'people' | 'notes';

interface PanelProps {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  participants: readonly RoomParticipantView[];
  invited: readonly PendingInvitee[];
  /** Open the member picker (Add member). */
  onAddMember: () => void;
  addBusy: boolean;
  /** The viewer hosts this meeting (the only host we can identify client-side). */
  isHost: boolean;
  height: number;
  bottom: number;
}

const TABS: { id: PanelTab; label: string; Icon: typeof MessageCircle }[] = [
  { id: 'chat', label: 'Chat', Icon: MessageCircle },
  { id: 'people', label: 'Participants', Icon: Users },
  { id: 'notes', label: 'Notes', Icon: StickyNote },
];

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The in-meeting panel (chat / participants / notes) over the live stage. The
 * meeting keeps running underneath; the panel is glass over the blurred stage.
 * One panel with tabs, like the reference design, opened at the tab the user
 * asked for (Chat, Members, Notes).
 */
export function MeetingPanel({ tab, onTab, onClose, participants, invited, onAddMember, addBusy, isHost, height, bottom }: PanelProps) {
  const skin = useMeetingSkin();
  const data = useMeetingData();
  const { meetingHub } = useCalls();

  // Reading the chat clears its unread count; it starts counting again on close.
  useEffect(() => {
    meetingHub.setChatVisible(tab === 'chat');
    return () => meetingHub.setChatVisible(false);
  }, [tab, meetingHub]);

  return (
    <GlassPanel style={[styles.panel, { height, bottom }]} radius={26}>
      <View style={styles.grab} />
      <View style={styles.tabs}>
        <View style={[styles.tabTrack, { backgroundColor: 'rgba(255,255,255,0.08)' }]}>
          {TABS.map(({ id, label, Icon }) => {
            const on = id === tab;
            return (
              <Pressable
                key={id}
                onPress={() => onTab(id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[styles.tab, on && { backgroundColor: skin.accent }]}
              >
                <Icon size={14} color={on ? skin.accentInk : skin.muted} />
                <Text style={[styles.tabText, { color: on ? skin.accentInk : skin.muted }]} numberOfLines={1}>
                  {label}
                  {id === 'people' ? ` (${participants.length})` : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close panel" style={styles.close}>
          <X size={20} color={skin.ink} />
        </Pressable>
      </View>

      {tab === 'chat' ? <ChatTab entries={data.chat} loading={data.loadingHistory} keepFailed={data.keepFailed} /> : null}
      {tab === 'people' ? <PeopleTab participants={participants} invited={invited} onAdd={onAddMember} busy={addBusy} isHost={isHost} /> : null}
      {tab === 'notes' ? <NotesTab notes={data.notes} keepFailed={data.keepFailed} /> : null}
    </GlassPanel>
  );
}

// ── shared composer ─────────────────────────────────────────────────────────

function Composer({ placeholder, max, onSend, autoFocus }: { placeholder: string; max: number; onSend: (text: string) => void; autoFocus?: boolean }) {
  const skin = useMeetingSkin();
  const [text, setText] = useState('');
  const can = text.trim().length > 0;
  const send = () => {
    if (!can) return;
    onSend(text);
    setText('');
  };
  return (
    <View style={[styles.composer, { borderColor: skin.glassBorder }]}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={skin.faint}
        style={[styles.input, { color: skin.ink }]}
        multiline
        maxLength={max}
        autoFocus={autoFocus}
        onSubmitEditing={send}
        blurOnSubmit={false}
        returnKeyType="send"
        accessibilityLabel={placeholder}
      />
      <Pressable
        onPress={send}
        disabled={!can}
        accessibilityRole="button"
        accessibilityLabel="Send"
        style={[styles.sendBtn, { backgroundColor: can ? skin.accent : 'rgba(255,255,255,0.12)' }]}
      >
        <Send size={17} color={can ? skin.accentInk : skin.faint} />
      </Pressable>
    </View>
  );
}

function useStickToEnd<T>(list: readonly T[]) {
  const ref = useRef<FlatList<T>>(null);
  const onContentSizeChange = useCallback(() => ref.current?.scrollToEnd({ animated: true }), []);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.scrollToEnd({ animated: false }), 50);
    return () => clearTimeout(t);
  }, []);
  void list;
  return { ref, onContentSizeChange };
}

// ── chat ────────────────────────────────────────────────────────────────────

const Bubble = memo(function Bubble({ m, mine, nameOf }: { m: ChatEntry; mine: boolean; nameOf: (id: string) => string }) {
  const skin = useMeetingSkin();
  return (
    <View style={[styles.msgRow, mine && { flexDirection: 'row-reverse' }]}>
      {!mine ? <Avatar name={m.fromName} size={30} /> : null}
      <View style={{ maxWidth: '78%' }}>
        <Text style={[styles.msgMeta, { color: skin.muted, textAlign: mine ? 'right' : 'left' }]} numberOfLines={1}>
          {mine ? 'You' : m.fromName} · {time(m.at)}
          {m.to ? ` · Private${mine ? ` to ${nameOf(m.to)}` : ''}` : ''}
        </Text>
        <View style={[styles.bubble, mine ? { backgroundColor: skin.accent, borderTopRightRadius: 4 } : { backgroundColor: 'rgba(255,255,255,0.12)', borderTopLeftRadius: 4 }]}>
          <Text style={{ color: mine ? skin.accentInk : skin.ink, fontSize: 14, lineHeight: 19 }} selectable>
            {m.text}
          </Text>
        </View>
      </View>
    </View>
  );
});

function ChatTab({ entries, loading, keepFailed }: { entries: ChatEntry[]; loading: boolean; keepFailed: boolean }) {
  const skin = useMeetingSkin();
  const me = useSession((s) => s.user?.id);
  const { meetingHub, room } = useCalls();
  const { ref, onContentSizeChange } = useStickToEnd(entries);
  const nameOf = useCallback((id: string) => room.getSnapshot().participants.find((p) => p.identity === id)?.name ?? 'someone', [room]);
  return (
    <View style={styles.body}>
      <FlatList
        ref={ref}
        data={entries}
        keyExtractor={(m) => m.id}
        onContentSizeChange={onContentSizeChange}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={loading ? <ActivityIndicator color={skin.accent} style={{ marginBottom: 8 }} /> : null}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.empty}>
              <MessageCircle size={28} color={skin.faint} />
              <Text style={[styles.emptyText, { color: skin.muted }]}>No messages yet. Say hello to everyone in the meeting.</Text>
            </View>
          )
        }
        renderItem={({ item }) => <Bubble m={item} mine={item.from === me} nameOf={nameOf} />}
      />
      {keepFailed ? <Text style={[styles.warn, { color: skin.danger }]}>Some messages could not be saved to the meeting record.</Text> : null}
      <Composer placeholder="Type a message…" max={CHAT_TEXT_MAX} onSend={(t) => meetingHub.sendChat(t)} />
    </View>
  );
}

// ── participants ────────────────────────────────────────────────────────────

const PersonRow = memo(function PersonRow({ p, host }: { p: RoomParticipantView; host: boolean }) {
  const skin = useMeetingSkin();
  return (
    <View style={styles.person}>
      <Avatar name={p.name} size={38} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.personName, { color: skin.ink }]} numberOfLines={1}>
          {p.name}
          {p.isLocal ? ' (You)' : ''}
        </Text>
        <Text style={[styles.personMeta, { color: p.speaking ? skin.accent : skin.faint }]}>{p.speaking ? 'Speaking' : p.isLocal ? 'Online' : 'Joined'}</Text>
      </View>
      {p.handRaised ? (
        <Text style={styles.handEmoji} accessibilityLabel="hand raised">✋</Text>
      ) : null}
      {host ? (
        <View style={[styles.hostBadge, { backgroundColor: skin.accent }]}>
          <Text style={{ color: skin.accentInk, fontSize: 10, fontWeight: '800' }}>Host</Text>
        </View>
      ) : null}
      {p.micOn ? <Mic size={17} color={skin.muted} /> : <MicOff size={17} color={skin.danger} />}
      {p.camOn ? <VideoIcon size={17} color={skin.muted} /> : <VideoOff size={17} color={skin.faint} />}
    </View>
  );
});

function PeopleTab({ participants, invited, onAdd, busy, isHost }: { participants: readonly RoomParticipantView[]; invited: readonly PendingInvitee[]; onAdd: () => void; busy: boolean; isHost: boolean }) {
  const skin = useMeetingSkin();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? participants.filter((p) => p.name.toLowerCase().includes(n)) : participants;
  }, [participants, q]);
  return (
    <View style={styles.body}>
      <View style={[styles.search, { borderColor: skin.glassBorder }]}>
        <Search size={16} color={skin.faint} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search members…"
          placeholderTextColor={skin.faint}
          style={[styles.searchInput, { color: skin.ink }]}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search members"
        />
      </View>
      <Text style={[styles.section, { color: skin.muted }]}>In meeting ({participants.length})</Text>
      <FlatList
        data={list}
        keyExtractor={(p) => p.identity}
        renderItem={({ item }) => <PersonRow p={item} host={isHost && item.isLocal} />}
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={
          invited.length > 0 ? (
            <View>
              <Text style={[styles.section, { color: skin.muted, marginTop: 10 }]}>Invited</Text>
              {invited.map((i) => (
                <View key={i.id} style={styles.person}>
                  <Avatar name={i.name} size={38} />
                  <Text style={[styles.personName, { color: skin.ink, flex: 1 }]} numberOfLines={1}>
                    {i.name}
                  </Text>
                  <Text style={[styles.personMeta, { color: skin.muted }]}>Ringing…</Text>
                </View>
              ))}
            </View>
          ) : null
        }
        style={{ flex: 1 }}
      />
      <Pressable
        onPress={() => {
          Keyboard.dismiss();
          onAdd();
        }}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Add member"
        style={({ pressed }) => [styles.addBtn, { backgroundColor: skin.accent, opacity: busy ? 0.6 : pressed ? 0.85 : 1 }]}
      >
        {busy ? <ActivityIndicator size="small" color={skin.accentInk} /> : <UserPlus size={18} color={skin.accentInk} />}
        <Text style={[styles.addBtnText, { color: skin.accentInk }]}>Add Member</Text>
      </Pressable>
    </View>
  );
}

// ── notes ───────────────────────────────────────────────────────────────────

const NoteRow = memo(function NoteRow({ n }: { n: NoteEntry }) {
  const skin = useMeetingSkin();
  return (
    <View style={styles.note}>
      <Text style={{ color: skin.accent, fontSize: 16, lineHeight: 20 }}>•</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: skin.ink, fontSize: 14, lineHeight: 19 }} selectable>
          {n.text}
        </Text>
        <Text style={{ color: skin.faint, fontSize: 11, marginTop: 2 }}>
          {n.author} · {time(n.at)}
        </Text>
      </View>
    </View>
  );
});

function NotesTab({ notes, keepFailed }: { notes: NoteEntry[]; keepFailed: boolean }) {
  const skin = useMeetingSkin();
  const { meetingHub } = useCalls();
  const { ref, onContentSizeChange } = useStickToEnd(notes);
  return (
    <View style={styles.body}>
      <View style={styles.notesHead}>
        <Text style={[styles.notesTitle, { color: skin.ink }]}>Meeting Notes</Text>
        {keepFailed ? (
          <Text style={{ color: skin.danger, fontSize: 12, fontWeight: '700' }}>Not saved</Text>
        ) : (
          <View style={styles.saved}>
            <Check size={13} color={skin.success} />
            <Text style={{ color: skin.success, fontSize: 12, fontWeight: '700' }}>Saved</Text>
          </View>
        )}
      </View>
      <FlatList
        ref={ref}
        data={notes}
        keyExtractor={(n) => n.id}
        onContentSizeChange={onContentSizeChange}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <StickyNote size={28} color={skin.faint} />
            <Text style={[styles.emptyText, { color: skin.muted }]}>Write down the important points. Everyone in the meeting sees them, and they are kept with the meeting.</Text>
          </View>
        }
        renderItem={({ item }) => <NoteRow n={item} />}
      />
      <Composer placeholder="Add a note…" max={NOTE_TEXT_MAX} onSend={(t) => meetingHub.addNote(t)} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { position: 'absolute', left: 10, right: 10 },
  grab: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.28)', marginTop: 8 },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  tabTrack: { flex: 1, flexDirection: 'row', borderRadius: 14, padding: 3, gap: 2 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, borderRadius: 11, minWidth: 0 },
  tabText: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, paddingHorizontal: 12, paddingBottom: 12 },
  list: { paddingVertical: 8, gap: 12, flexGrow: 1 },
  msgRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  msgMeta: { fontSize: 11, marginBottom: 3 },
  bubble: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 28, paddingVertical: 30 },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  warn: { fontSize: 12, fontWeight: '600', paddingBottom: 6 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 22, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.06)' },
  input: { flex: 1, maxHeight: 96, fontSize: 14, paddingVertical: 6 },
  sendBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 14, paddingHorizontal: 12, height: 40, backgroundColor: 'rgba(255,255,255,0.06)' },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  section: { fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  hostBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  personName: { fontSize: 14, fontWeight: '600' },
  personMeta: { fontSize: 11, marginTop: 1 },
  addBtn: { height: 46, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 },
  addBtnText: { fontSize: 15, fontWeight: '800' },
  notesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6 },
  notesTitle: { fontSize: 16, fontWeight: '800' },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  handEmoji: { fontSize: 16, lineHeight: 20 },
});
