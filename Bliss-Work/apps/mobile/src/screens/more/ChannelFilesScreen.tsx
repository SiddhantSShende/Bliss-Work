import { useMemo, useState } from 'react';
import { ArrowLeft, File, FileText, Image as ImageIcon, Video } from 'lucide-react-native';
import { ActivityIndicator, Alert, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { parseChatEnvelope, prettySize, type MediaItem } from '@taskboard/app/chatEnvelope';
import { EmptyState } from '../../components/EmptyState';
import { useChannelMessages } from '../../hooks/useChannels';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'ChannelFiles'>;

interface FileRow {
  item: MediaItem;
  sentAt: string;
}

/**
 * Files shared in this channel — derived from message history, not a
 * dedicated "list files" endpoint (there isn't one: message bodies are
 * encrypted at rest, so the server itself cannot see which messages carry
 * attachments — see packages/app/src/lib/chatEnvelope.ts's own doc comment.
 * This scans the already-decrypted messages this device has fetched for the
 * media envelope every attachment message carries, exactly how web's own
 * file views work).
 *
 * Tapping a file resolves a short-lived signed URL (`api.attachmentLinks`)
 * and opens it via the OS's own viewer/browser — no download step, no Share
 * button, matching the spec: this is "open", not "save a copy".
 */
export function ChannelFilesScreen({ route, navigation }: Props) {
  const { channelId, channelName } = route.params;
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const { messages, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useChannelMessages(channelId);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const files: FileRow[] = useMemo(() => {
    const rows: FileRow[] = [];
    for (const m of messages) {
      const envelope = parseChatEnvelope(m.body);
      if (envelope?.kind === 'media') {
        for (const item of envelope.items) {
          if (!item.thumbId || item.id !== item.thumbId) rows.push({ item, sentAt: m.createdAt });
        }
      }
    }
    return rows.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }, [messages]);

  const openFile = async (row: FileRow) => {
    setOpeningId(row.item.id);
    try {
      const [link] = await api.attachmentLinks([row.item.id]);
      if (!link) throw new Error('no link');
      await Linking.openURL(link.url);
    } catch {
      Alert.alert("Couldn't open file", 'Please try again.');
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <View>
          <Text style={styles.headerTitle}>{channelName}</Text>
          <Text style={styles.headerSubtitle}>Shared Files</Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(f) => f.item.id}
          contentContainerStyle={styles.list}
          onEndReached={() => hasNextPage && !isFetchingNextPage && void fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={isFetchingNextPage ? <ActivityIndicator color={colors.accent} /> : null}
          ListEmptyComponent={<EmptyState icon={File} title="No files shared yet" subtitle="Files shared in this channel will show up here." />}
          renderItem={({ item: row }) => (
            <Pressable onPress={() => void openFile(row)} style={styles.row} disabled={openingId === row.item.id}>
              <View style={styles.iconWrap}>
                {openingId === row.item.id ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <FileTypeIcon mime={row.item.mime} color={colors.accent} />
                )}
              </View>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {row.item.name}
                </Text>
                <Text style={styles.meta}>
                  {prettySize(row.item.size)} · {new Date(row.sentAt).toLocaleDateString()}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function FileTypeIcon({ mime, color }: { mime: string; color: string }) {
  if (mime.startsWith('image/')) return <ImageIcon size={18} color={color} />;
  if (mime.startsWith('video/')) return <Video size={18} color={color} />;
  if (mime === 'application/pdf' || mime.startsWith('text/')) return <FileText size={18} color={color} />;
  return <File size={18} color={color} />;
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
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg, textAlign: 'center' },
    headerSubtitle: { fontSize: 12, color: colors.muted, textAlign: 'center' },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'] },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: { flex: 1, gap: 2 },
    name: { fontSize: 14, fontWeight: '600', color: colors.fg },
    meta: { fontSize: 12, color: colors.muted },
  });
}
