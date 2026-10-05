import { useMemo } from 'react';
import { ArrowLeft, Hash, Lock, MoreVertical, Users } from 'lucide-react-native';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { Button } from '../../components/Button';
import { Tabs } from '../../components/Tab';
import { qk } from '../../hooks/queryKeys';
import { useJoinChannel } from '../../hooks/useChannels';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'ChannelDetail'>;

/**
 * Channel info — banner (icon, name, member count, public/private, Join)
 * plus a Chat/Files/Members tab row, mirroring the reference's Channel
 * Details screen. The tabs are navigation triggers rather than inline
 * panels: Chat opens the thread (ChannelConversation
 * already owns that UI — no point re-rendering it here), Files and Members
 * push their own dedicated screens (ChannelFilesScreen/ChannelMembersScreen)
 * so each stays a focused, single-purpose screen.
 *
 * `channels()` doesn't carry a description or created-date field (see
 * ChannelDTO in packages/shared) — this banner shows only what's real:
 * member count, public/private (isLocked), and the caller's own membership.
 */
export function ChannelDetailScreen({ route, navigation }: Props) {
  const { channelId, channelName } = route.params;
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const join = useJoinChannel();

  const { data: channel, isLoading } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    select: (all) => all.find((c) => c.id === channelId),
  });

  const isMember = channel?.myRole ? channel.myRole.length > 0 : true; // assume member if we don't know yet (came from an owned list)

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {channelName}
        </Text>
        <Pressable onPress={() => navigation.navigate('ChannelSettings', { channelId, channelName })} hitSlop={8}>
          <MoreVertical size={22} color={colors.fg} />
        </Pressable>
      </View>

      <View style={styles.banner}>
        <View style={styles.bannerIcon}>
          <Hash size={32} color={colors.accent} />
        </View>
        <Text style={styles.bannerName}>{channelName}</Text>
        {isLoading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.sm }} />
        ) : (
          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Users size={14} color={colors.muted} />
              <Text style={styles.metaText}>{channel?.memberCount ?? '—'}</Text>
            </View>
            <View style={styles.metaItem}>
              {channel?.isLocked ? <Lock size={14} color={colors.muted} /> : <Hash size={14} color={colors.muted} />}
              <Text style={styles.metaText}>{channel?.isLocked ? 'Private' : 'Public'}</Text>
            </View>
          </View>
        )}

        {!isLoading && !isMember ? (
          <Button
            title="Join"
            loading={join.isPending}
            onPress={() => join.mutate(channelId)}
            style={styles.joinBtn}
          />
        ) : null}
      </View>

      <Tabs
        tabs={[
          { key: 'chat', label: 'Chat' },
          { key: 'files', label: 'Files' },
          { key: 'members', label: 'Members' },
        ]}
        active="chat"
        onChange={(key) => {
          if (key === 'chat') navigation.navigate('ChannelConversation', { channelId, channelName });
          else if (key === 'files') navigation.navigate('ChannelFiles', { channelId, channelName });
          else navigation.navigate('ChannelMembers', { channelId, channelName });
        }}
      />
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
    headerTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.fg, textAlign: 'center' },
    banner: { alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.xs },
    bannerIcon: {
      width: 72,
      height: 72,
      borderRadius: 20,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.sm,
    },
    bannerName: { fontSize: 18, fontWeight: '700', color: colors.fg },
    metaRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
    metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    metaText: { fontSize: 13, color: colors.muted },
    joinBtn: { marginTop: spacing.md, paddingHorizontal: spacing['2xl'] },
  });
}
