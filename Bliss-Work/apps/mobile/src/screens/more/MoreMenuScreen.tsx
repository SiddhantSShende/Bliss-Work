import { useMemo } from 'react';
import { Building2, Hash, Mail, Plus, Settings as SettingsIcon, User, Users } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSession } from '@taskboard/app/store/session';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/Card';
import { ListRow } from '../../components/ListRow';
import { Badge } from '../../components/Badge';
import { useMailInbox } from '../../hooks/useMailInbox';
import { useChannels } from '../../hooks/useChannels';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';
import { OrgSwitcherCard } from './OrgSwitcherCard';

type Props = NativeStackScreenProps<MoreStackParamList, 'MoreMenu'>;

/**
 * The More tab's landing screen — mirrors the reference's "More" screen:
 * a workspace switcher card, a Communication section (Mail/Channels/
 * Members/Org — folded in from the old standalone WorkspaceScreen, which
 * this replaces), and a Settings row. The account hub (My Profile/
 * Notifications/Theme/Privacy & Security/Sign out — the reference's
 * "Profile" screen) is one tap away via the header avatar, not the tab
 * itself, matching how the reference separates the two.
 */
export function MoreMenuScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const user = useSession((s) => s.user);
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: mailPage } = useMailInbox();
  const { data: channels } = useChannels();

  const mailUnread = mailPage?.items.reduce((sum, it) => sum + it.unreadCount, 0) ?? 0;
  const channelsUnread = channels?.reduce((sum, c) => sum + c.unread, 0) ?? 0;

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>More</Text>
        <Pressable onPress={() => navigation.navigate('Account')} hitSlop={8}>
          <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} size={30} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>Workspace</Text>
        <OrgSwitcherCard />

        <Text style={styles.sectionLabel}>Communication</Text>
        <Card noPadding>
          <ListRow
            leading={
              <View style={styles.iconWrap}>
                <Mail size={18} color={colors.accent} />
              </View>
            }
            title="Mail"
            trailing={mailUnread ? <Badge count={mailUnread} /> : undefined}
            onPress={() => navigation.navigate('Mail')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={
              <View style={styles.iconWrap}>
                <Hash size={18} color={colors.accent} />
              </View>
            }
            title="Channels"
            trailing={
              <View style={styles.channelsTrailing}>
                {channelsUnread ? <Badge count={channelsUnread} /> : null}
                <Pressable
                  onPress={() => navigation.navigate('CreateChannel', undefined)}
                  hitSlop={8}
                  style={styles.createChannelButton}
                >
                  <Plus size={16} color={colors.accentFg} />
                </Pressable>
              </View>
            }
            onPress={() => navigation.navigate('Channels')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={
              <View style={styles.iconWrap}>
                <Users size={18} color={colors.accent} />
              </View>
            }
            title="Members"
            onPress={() => navigation.navigate('Members')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={
              <View style={styles.iconWrap}>
                <Building2 size={18} color={colors.accent} />
              </View>
            }
            title="Org"
            onPress={() => navigation.navigate('Org')}
          />
        </Card>

        <Card noPadding style={{ marginTop: spacing.md }}>
          <ListRow
            leading={
              <View style={styles.iconWrap}>
                <SettingsIcon size={18} color={colors.accent} />
              </View>
            }
            title="Settings"
            onPress={() => navigation.navigate('Settings')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={
              <View style={styles.iconWrap}>
                <User size={18} color={colors.accent} />
              </View>
            }
            title="Profile"
            onPress={() => navigation.navigate('Account')}
          />
        </Card>
      </ScrollView>
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
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    headerTitle: { fontSize: 22, fontWeight: '700', color: colors.fg },
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.sm },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginTop: spacing.sm,
      marginBottom: spacing.xs,
    },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    channelsTrailing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    createChannelButton: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginLeft: spacing.md + 36 + spacing.md,
    },
  });
}
