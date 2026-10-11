import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react-native';
import { ActivityIndicator, Alert, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import type { UserDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { displayNameOf } from '@taskboard/app/lib/userLabel';
import { useDirectory } from '../../hooks/useDirectory';
import { useConversations } from '../../hooks/useConversations';
import { useCalls } from '../../calls/CallProvider';
import { canCallTogether } from '../../calls/conferenceCall';
import { usePresence } from '../../hooks/usePresence';
import { qk } from '../../hooks/queryKeys';
import { Avatar } from '../../components/Avatar';
import { Checkbox } from '../../components/Checkbox';
import { SearchInput } from '../../components/SearchInput';
import { Button } from '../../components/Button';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { ChatsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<ChatsStackParamList, 'NewChat'>;

const RECENT_LIMIT = 6;

/**
 * New Chat: search the org directory, Recent (most recently messaged) and
 * All Members sections, multi-select checkboxes. "Start Chat" opens/creates
 * a 1:1 DM per selected person (real `api.openConversation` calls) and lands
 * on the first one — there is no ad-hoc group-DM concept in this domain
 * (only named Channels, a separate object with their own creation flow this
 * screen's spec didn't ask for), so a multi-select here means "start these
 * conversations", not "create a group".
 */
export function NewChatScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { api } = useRuntime();
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [calling, setCalling] = useState(false);
  const { startConferenceCall } = useCalls();
  const { filtered, isLoading } = useDirectory(query);
  const { data: conversations = [] } = useConversations();

  const recentIds = useMemo(
    () =>
      [...conversations]
        .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
        .slice(0, RECENT_LIMIT)
        .map((c) => c.peerId),
    [conversations],
  );
  const allIds = useMemo(() => new Set(filtered.map((u) => u.id)), [filtered]);
  const byId = useMemo(() => new Map(filtered.map((u) => [u.id, u])), [filtered]);
  const online = usePresence(filtered.map((u) => u.id));

  const recent = recentIds.filter((id) => allIds.has(id)).map((id) => byId.get(id)!);
  const others = filtered.filter((u) => !recentIds.includes(u.id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startChat = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setStarting(true);
    try {
      // Sequential rather than Promise.all: each open() is a single
      // idempotent POST, and running them one at a time means the FIRST
      // person's own result — the one navigated to below — is captured
      // directly from its own call rather than raced against the others'.
      let firstConversationId: string | undefined;
      for (const peerId of ids) {
        // eslint-disable-next-line no-await-in-loop
        const { conversationId } = await api.openConversation(peerId);
        if (peerId === ids[0]) firstConversationId = conversationId;
      }
      await qc.invalidateQueries({ queryKey: qk.conversations });
      const firstPeer = filtered.find((u) => u.id === ids[0]);
      navigation.replace('ChatConversation', {
        conversationId: firstConversationId!,
        peerId: ids[0]!,
        peerName: firstPeer ? displayNameOf({ peerDisplayName: firstPeer.displayName, peerUsername: firstPeer.username }) : '',
      });
    } finally {
      setStarting(false);
    }
  };

  // "Call": everyone ticked, in ONE call — not a chat per person, not a meeting.
  const callSelected = async () => {
    setCalling(true);
    try {
      const out = await startConferenceCall([...selected], 'video');
      if (out.ok) navigation.goBack();
      else Alert.alert("Couldn't start the call", out.message);
    } finally {
      setCalling(false);
    }
  };

  const renderRow = (user: UserDTO) => (
    <Pressable onPress={() => toggle(user.id)} style={styles.row}>
      <Avatar name={user.displayName} src={user.avatarUrl} size={40} online={online.has(user.id)} />
      <Text style={styles.name} numberOfLines={1}>
        {user.displayName}
      </Text>
      <Checkbox checked={selected.has(user.id)} onPress={() => toggle(user.id)} />
    </Pressable>
  );

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>New Chat</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search people..." />
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <SectionList
          sections={[
            ...(recent.length > 0 && !query ? [{ title: 'Recent', data: recent }] : []),
            // While searching, show every match (recent/non-recent distinction
            // isn't useful mid-search); otherwise show only the non-recent
            // rest, since Recent above already covers the others.
            { title: 'All Members', data: query ? filtered : others },
          ].filter((s) => s.data.length > 0)}
          keyExtractor={(u) => u.id}
          renderItem={({ item }) => renderRow(item)}
          renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
          contentContainerStyle={styles.list}
        />
      )}

      {selected.size > 0 ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          <Button
            title={`Start Chat${selected.size > 1 ? ` (${selected.size})` : ''}`}
            onPress={() => void startChat()}
            loading={starting}
            disabled={calling}
          />
          {canCallTogether(selected.size) ? (
            <Button
              title={`Call (${selected.size})`}
              variant="ghost"
              onPress={() => void callSelected()}
              loading={calling}
              disabled={starting}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    spinner: { marginTop: spacing['2xl'] },
    list: { paddingBottom: spacing['2xl'] },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
      backgroundColor: colors.bg,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    name: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.fg },
    footer: {
      gap: spacing.sm,
      padding: spacing.lg,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
  });
}
