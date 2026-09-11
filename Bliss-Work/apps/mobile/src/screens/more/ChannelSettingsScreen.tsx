import { useMemo, useState } from 'react';
import { ArrowLeft, LogOut } from 'lucide-react-native';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { Card } from '../../components/Card';
import { TextField } from '../../components/TextField';
import { Button } from '../../components/Button';
import { qk } from '../../hooks/queryKeys';
import { useLeaveChannel, useRenameChannel } from '../../hooks/useChannels';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { AppTabParamList, MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'ChannelSettings'>;

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/**
 * Channel Settings — real fields only: name (editable if the caller is
 * owner/admin, via `api.renameChannel`), type (read-only — `isLocked` has no
 * write path exposed beyond creation), the caller's own role, and Leave
 * Channel. No "Notifications" toggle: there is no per-channel mute/
 * notification-preference endpoint in the API to back one.
 */
export function ChannelSettingsScreen({ route, navigation }: Props) {
  const { channelId, channelName } = route.params;
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  const rename = useRenameChannel();
  const leave = useLeaveChannel();
  const [name, setName] = useState(channelName);

  const { data: channel } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    select: (all) => all.find((c) => c.id === channelId),
  });

  const canRename = channel?.myRole === 'owner' || channel?.myRole === 'admin';
  const dirty = canRename && name.trim().length > 0 && name.trim() !== channelName;

  const confirmLeave = () => {
    Alert.alert('Leave channel?', `You'll stop receiving messages from ${channelName}.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () =>
          leave.mutate(channelId, {
            onSuccess: () => {
              navigation.getParent<BottomTabNavigationProp<AppTabParamList>>()?.navigate('More', { screen: 'Channels' });
            },
          }),
      },
    ]);
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <View>
          <Text style={styles.headerTitle}>{channelName}</Text>
          <Text style={styles.headerSubtitle}>{channel?.isLocked ? 'Private Channel' : 'Public Channel'}</Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.content}>
        <Text style={styles.sectionLabel}>Channel Info</Text>
        <Card style={styles.card}>
          <TextField label="Name" value={name} onChangeText={setName} editable={canRename} maxLength={80} />
          {dirty ? (
            <Button
              title="Save name"
              onPress={() => rename.mutate({ channelId, name: name.trim() })}
              loading={rename.isPending}
            />
          ) : null}
          <View>
            <Text style={styles.fieldLabel}>Type</Text>
            <Text style={styles.fieldValue}>{channel?.isLocked ? 'Private' : 'Public'}</Text>
          </View>
          <View>
            <Text style={styles.fieldLabel}>Your role</Text>
            <Text style={styles.fieldValue}>{ROLE_LABEL[channel?.myRole ?? ''] ?? '—'}</Text>
          </View>
        </Card>

        <Pressable onPress={confirmLeave} style={styles.leaveRow}>
          <LogOut size={18} color={colors.danger} />
          <Text style={styles.leaveText}>Leave Channel</Text>
        </Pressable>
      </View>
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
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg, textAlign: 'center' },
    headerSubtitle: { fontSize: 12, color: colors.muted, textAlign: 'center' },
    content: { padding: spacing.lg, gap: spacing.md },
    sectionLabel: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
    card: { gap: spacing.md },
    fieldLabel: { fontSize: 12, color: colors.muted },
    fieldValue: { fontSize: 14, fontWeight: '600', color: colors.fg, marginTop: 2 },
    leaveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.danger,
    },
    leaveText: { fontSize: 15, fontWeight: '700', color: colors.danger },
  });
}
