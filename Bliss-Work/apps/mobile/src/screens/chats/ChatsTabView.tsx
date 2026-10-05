import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, MoreVertical, Pin, Trash2 } from 'lucide-react-native';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import type { ConversationDTO } from '@taskboard/shared';
import { displayNameOf, useUserLabels } from '@taskboard/app/lib/userLabel';
import { useSession } from '@taskboard/app/store/session';
import { useConversations } from '../../hooks/useConversations';
import { usePresence } from '../../hooks/usePresence';
import { usePinnedThreads } from '../../lib/pinnedThreads';
import { Avatar } from '../../components/Avatar';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { ListEmpty } from '../../components/QueryState';
import { rowPreview } from '../../lib/rowPreview';
import { timeAgo } from '../../lib/timeAgo';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import { ChatRowMenu } from './ChatRowMenu';
import { SwipeToDelete, closeOpenSwipeRows } from '../../components/SwipeToDelete';
import { Alert } from 'react-native';
import { errorText } from '@taskboard/app/lib/errorText';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../hooks/queryKeys';

export function ChatsTabView({ navigation, query = '' }: { navigation: any; query?: string }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: conversations = [], isLoading, isError, error, isRefetching, refetch } = useConversations();
  const [menuFor, setMenuFor] = useState<ConversationDTO | null>(null);
  const me = useSession((s) => s.user);
  const { api } = useRuntime();
  const qc = useQueryClient();

  const peerIds = useMemo(() => conversations.map((c) => c.peerId), [conversations]);
  const { avatarUrlOf } = useUserLabels(peerIds);
  const online = usePresence(peerIds);

  const { isChatPinned, pinnedChatIds } = usePinnedThreads();

  // A row left swiped open must not stay open when the user leaves this screen and comes back.
  useEffect(() => {
    const unsub = navigation.addListener('blur', closeOpenSwipeRows);
    return () => {
      unsub();
      closeOpenSwipeRows();
    };
  }, [navigation]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .filter((c) => {
        if (!q) return true;
        return displayNameOf(c).toLowerCase().includes(q) || (c.lastMessage ?? '').toLowerCase().includes(q);
      })
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  }, [conversations, query]);

  // Pinned rows keep the device's pin order (newest-pinned first), never the
  // conversation's own recency sort — that's the whole point of pinning one.
  // No separate "Pinned" section when nothing is pinned or the split would be
  // pointless (search always searches everything regardless).
  const sections = useMemo(() => {
    if (pinnedChatIds.length === 0) return [{ title: null, data: filtered }];
    const byId = new Map(filtered.map((c) => [c.id, c]));
    const pinned = pinnedChatIds.map((id) => byId.get(id)).filter((c): c is ConversationDTO => !!c);
    const rest = filtered.filter((c) => !isChatPinned(c.id));
    const out: { title: string | null; data: ConversationDTO[] }[] = [];
    if (pinned.length > 0) out.push({ title: 'Pinned', data: pinned });
    if (rest.length > 0) out.push({ title: pinned.length > 0 ? 'All Chats' : null, data: rest });
    return out;
  }, [filtered, pinnedChatIds, isChatPinned]);

  return (
    <View style={styles.flex}>
      <SectionList
        sections={sections}
        keyExtractor={(c) => c.id}
        refreshing={isRefetching}
        onRefresh={() => {
          closeOpenSwipeRows();
          void refetch();
        }}
        onScrollBeginDrag={closeOpenSwipeRows}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={styles.sectionHeader}>
              {section.title === 'Pinned' ? <Pin size={12} color={colors.muted} /> : null}
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <ListEmpty
            isLoading={isLoading}
            isError={isError}
            error={error}
            onRetry={() => void refetch()}
            errorTitle="Unable to load chats"
            loadingLabel="Loading chats..."
            empty={
              query.trim() ? (
                <EmptyState icon={MessageCircle} title="No matching chats" />
              ) : (
                <EmptyState icon={MessageCircle} title="No chats yet" subtitle="Start a new conversation with the + button." />
              )
            }
          />
        }
        renderItem={({ item }) => (
          <SwipeToDelete
            swipeId={item.id}
            // Same two calls web's ChatsList makes: hide the history, then drop the
            // conversation off the list. Clearing alone left the row in the server's
            // list (only hidden while this row instance stayed mounted).
            onDelete={() => api.clearConversation(item.id).then(() => api.ignoreConversation(item.id)).then(() => void qc.invalidateQueries({ queryKey: qk.conversations })).catch((e) => { Alert.alert('Could not delete this chat', errorText(e)); throw e; })}
            deleteActionComponent={<Trash2 size={24} color="#fff" />}
          >
            <Pressable
              onPress={() =>
                navigation.navigate('ChatConversation', {
                  conversationId: item.id,
                  peerId: item.peerId,
                  peerName: displayNameOf(item),
                })
              }
              style={styles.row}
            >
              <Avatar name={displayNameOf(item)} src={avatarUrlOf(item.peerId)} online={online.has(item.peerId)} />
              <View style={styles.rowText}>
                <View style={styles.rowTop}>
                  {isChatPinned(item.id) ? <Pin size={12} color={colors.muted} /> : null}
                  <Text style={styles.name} numberOfLines={1}>
                    {displayNameOf(item)}
                  </Text>
                  {item.lastMessageAt ? <Text style={styles.time}>{timeAgo(item.lastMessageAt)}</Text> : null}
                </View>
                <View style={styles.rowBottom}>
                  <Text style={styles.preview} numberOfLines={1}>
                    {item.cleared ? '' : rowPreview(item, me?.id)}
                  </Text>
                  {item.unread > 0 ? <Badge count={item.unread} /> : null}
                </View>
              </View>
              <Pressable onPress={() => setMenuFor(item)} hitSlop={8} style={styles.menuButton}>
                <MoreVertical size={18} color={colors.muted} />
              </Pressable>
            </Pressable>
          </SwipeToDelete>
        )}
      />

      {menuFor ? (
        <ChatRowMenu
          visible
          onClose={() => setMenuFor(null)}
          conversationId={menuFor.id}
          peerId={menuFor.peerId}
          blockedByMe={menuFor.blockedByMe}
        />
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    list: { paddingBottom: spacing['2xl'] },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
      backgroundColor: colors.bg,
    },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowText: { flex: 1, gap: 4 },
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs },
    rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg, flex: 1 },
    time: { fontSize: 12, color: colors.muted },
    preview: { fontSize: 13, color: colors.muted, flex: 1 },
    menuButton: { padding: spacing.xs },
  });
}
