import { useMemo, useState } from 'react';
import { Inbox, Mail as MailIcon, PenSquare, RotateCcw, Star, Trash2 } from 'lucide-react-native';
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { InboxItemDTO, MailDraftDTO } from '@taskboard/shared';
import { errorText } from '@taskboard/app/lib/errorText';
import { inFolder, isFeedFolder, isOutgoing, listTime, MAIL_FOLDERS, splitMailPreview, type MailFolder } from '@taskboard/app/lib/mailView';
import { useMailInbox } from '../../hooks/useMailInbox';
import { useDeletedMail, useDeleteMail, useDiscardDraft, useMailDrafts, useRestoreMail } from '../../hooks/useMailBoxes';
import { toggleMailFavorite, useMailPrefs } from '../../lib/mailPrefs';
import { SwipeToDelete, closeOpenSwipeRows } from '../../components/SwipeToDelete';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { ListEmpty } from '../../components/QueryState';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

const FOLDER_EMPTY: Record<MailFolder, string> = {
  inbox: 'Your inbox is empty',
  sent: 'Nothing sent yet',
  drafts: 'No drafts',
  deleted: 'Nothing deleted',
  favorites: 'No favourites yet — tap the star on a mail',
};

interface Props {
  navigation: { navigate: (route: string, params?: object) => void };
  /** Free-text filter (sender / subject / snippet), driven by the screen's search box. */
  query?: string;
}

/**
 * The mailbox: Inbox, Sent Items, Drafts, Deleted Items and Favourites — the
 * exact folder set and semantics of web's MailList (mailView.ts). Inbox / Sent /
 * Favourites read one feed (`api.inbox(['MAIL'])`) and are told apart by
 * direction (`statusBadge`) or the device-local star; Deleted is the same feed
 * with the predicate inverted; Drafts is its own listing (`api.mailDrafts`).
 */
export function MailBox({ navigation, query = '' }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [folder, setFolder] = useState<MailFolder>('inbox');
  const prefs = useMailPrefs();

  const live = useMailInbox();
  const trash = useDeletedMail(folder === 'deleted');
  const drafts = useMailDrafts(folder === 'drafts');
  const del = useDeleteMail();
  const restore = useRestoreMail();
  const discard = useDiscardDraft();

  const q = query.trim().toLowerCase();
  const feedQuery = folder === 'deleted' ? trash : live;

  const rows = useMemo(() => {
    const items = feedQuery.data?.pages.flatMap((p) => p.items) ?? [];
    return items.filter((it) => {
      if (!isFeedFolder(folder) || !inFolder(it, folder, prefs.isFavorite(it.refId))) return false;
      if (!q) return true;
      return (it.peerUsername ?? '').toLowerCase().includes(q) || it.preview.toLowerCase().includes(q);
    });
  }, [feedQuery.data, folder, prefs, q]);

  const draftRows = useMemo(
    () =>
      (drafts.data ?? []).filter(
        (d) => !q || d.preview.toLowerCase().includes(q) || d.to.some((a) => a.toLowerCase().includes(q)),
      ),
    [drafts.data, q],
  );

  const unread = (live.data?.pages.flatMap((p) => p.items) ?? []).reduce((n, it) => (isOutgoing(it) ? n : n + it.unreadCount), 0);
  const active = folder === 'drafts' ? drafts : feedQuery;
  const fail = (title: string) => (e: unknown) => Alert.alert(title, errorText(e));

  const renderMail = ({ item }: { item: InboxItemDTO }) => {
    const { subject, snippet } = splitMailPreview(item.preview);
    const outgoing = isOutgoing(item);
    const starred = prefs.isFavorite(item.refId);
    const content = (
      <Pressable onPress={() => navigation.navigate('MailDetail', { mailId: item.refId })} style={styles.row} accessibilityRole="button">
        <View style={[styles.dot, item.unreadCount > 0 && !outgoing && styles.dotUnread]} />
        <View style={styles.rowText}>
          <View style={styles.rowTop}>
            <Text style={[styles.sender, item.unreadCount > 0 && styles.bold]} numberOfLines={1}>
              {outgoing ? `To: ${item.peerUsername ?? 'recipient'}` : item.peerUsername ?? 'Unknown sender'}
            </Text>
            <Text style={styles.time}>{listTime(item.lastEventAt)}</Text>
          </View>
          <Text style={[styles.subject, item.unreadCount > 0 && styles.bold]} numberOfLines={1}>
            {subject || '(no subject)'}
          </Text>
          {snippet ? (
            <Text style={styles.preview} numberOfLines={1}>
              {snippet}
            </Text>
          ) : null}
        </View>
        {item.unreadCount > 0 && !outgoing ? <Badge count={item.unreadCount} /> : null}
        {folder === 'deleted' ? (
          <Pressable
            hitSlop={8}
            onPress={() => restore.mutate(item.refId, { onError: fail('Could not restore this mail') })}
            accessibilityLabel="Restore mail"
          >
            <RotateCcw size={18} color={colors.accent} />
          </Pressable>
        ) : (
          <>
            <Pressable hitSlop={8} onPress={() => toggleMailFavorite(item.refId)} accessibilityLabel={starred ? 'Remove from favourites' : 'Add to favourites'}>
              <Star size={18} color={starred ? colors.warning : colors.muted} fill={starred ? colors.warning : 'transparent'} />
            </Pressable>
          </>
        )}
      </Pressable>
    );

    if (folder === 'deleted') {
      return content;
    }

    return (
      <SwipeToDelete
        swipeId={item.refId}
        onDelete={() => del.mutateAsync(item.refId).catch(e => { fail('Could not delete this mail')(e); throw e; })}
        deleteActionComponent={<Trash2 size={24} color="#fff" />}
      >
        {content}
      </SwipeToDelete>
    );
  };

  const renderDraft = ({ item }: { item: MailDraftDTO }) => (
    <SwipeToDelete
      swipeId={`draft_${item.mailId}`}
      onDelete={() => discard.mutateAsync(item.mailId).catch((e) => { fail('Could not discard this draft')(e); throw e; })}
      deleteActionComponent={<Trash2 size={24} color="#fff" />}
    >
      <Pressable onPress={() => navigation.navigate('MailCompose', { draftId: item.mailId })} style={styles.row} accessibilityRole="button">
        <View style={styles.dot} />
        <View style={styles.rowText}>
          <View style={styles.rowTop}>
            <Text style={styles.sender} numberOfLines={1}>
              {item.to.length ? `To: ${item.to.join(', ')}` : 'No recipient'}
            </Text>
            <Text style={styles.time}>{listTime(item.updatedAt)}</Text>
          </View>
          <Text style={styles.preview} numberOfLines={1}>
            {item.preview || '(empty draft)'}
          </Text>
        </View>
      </Pressable>
    </SwipeToDelete>
  );

  const empty = (
    <ListEmpty
      isLoading={active.isLoading}
      isError={active.isError}
      error={active.error}
      onRetry={() => void active.refetch()}
      errorTitle="Unable to load mail"
      loadingLabel="Loading mail..."
      empty={<EmptyState icon={folder === 'inbox' ? Inbox : MailIcon} title={q ? 'No matching mail' : FOLDER_EMPTY[folder]} />}
    />
  );

  const listProps = {
    contentContainerStyle: styles.list,
    refreshControl: <RefreshControl refreshing={active.isRefetching && !active.isLoading} onRefresh={() => void active.refetch()} tintColor={colors.accent} />,
    ListEmptyComponent: empty,
    onScrollBeginDrag: closeOpenSwipeRows,
  };

  return (
    <View style={styles.flex}>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folders}>
          {MAIL_FOLDERS.map((f) => {
            const on = f.key === folder;
            return (
              <Pressable key={f.key} onPress={() => setFolder(f.key)} style={[styles.folder, on && styles.folderOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
                <Text style={[styles.folderText, on && styles.folderTextOn]}>{f.label}</Text>
                {f.key === 'inbox' && unread > 0 ? <Badge count={unread} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {folder === 'drafts' ? (
        <FlatList data={draftRows} keyExtractor={(d) => d.mailId} renderItem={renderDraft} {...listProps} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(it) => it.refId}
          renderItem={renderMail}
          onEndReached={() => {
            if (active && 'hasNextPage' in active && active.hasNextPage && !active.isFetchingNextPage) {
              void active.fetchNextPage();
            }
          }}
          onEndReachedThreshold={0.4}
          {...listProps}
        />
      )}

      <Pressable onPress={() => navigation.navigate('MailCompose')} style={styles.fab} accessibilityRole="button" accessibilityLabel="Compose new mail">
        <PenSquare size={22} color={colors.accentFg} />
      </Pressable>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    folders: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    folder: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.surface2,
    },
    folderOn: { backgroundColor: colors.accent },
    folderText: { fontSize: 13, fontWeight: '600', color: colors.fg },
    folderTextOn: { color: colors.accentFg },
    list: { paddingBottom: 96, flexGrow: 1 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },
    dotUnread: { backgroundColor: colors.accent },
    rowText: { flex: 1, gap: 2 },
    rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
    sender: { fontSize: 14, color: colors.fg, flex: 1 },
    subject: { fontSize: 14, color: colors.fg },
    bold: { fontWeight: '700' },
    time: { fontSize: 12, color: colors.muted },
    preview: { fontSize: 13, color: colors.muted },
    fab: {
      position: 'absolute',
      right: spacing.lg,
      bottom: spacing.lg,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 6,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
    },
  });
}
