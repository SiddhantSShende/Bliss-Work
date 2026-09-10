import { useMemo } from 'react';
import { Building2, Hash, Mail, Users, type LucideIcon } from 'lucide-react-native';
import { ArrowLeft } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Card } from '../../components/Card';
import { ListRow } from '../../components/ListRow';
import { Badge } from '../../components/Badge';
import { useMailInbox } from '../../hooks/useMailInbox';
import { useChannels } from '../../hooks/useChannels';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';
import { OrgSwitcherCard } from './OrgSwitcherCard';

type Props = NativeStackScreenProps<MoreStackParamList, 'Workspace'>;

interface Item {
  key: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  onPress: (nav: Props['navigation']) => void;
}

/**
 * Mail / Channels / Members / Org — the old Home screen's feature grid,
 * minus the entries that now have their own bottom tab (Chats/Tasks/
 * Meetings) or moved to the account menu (Settings). Reached from Chats'
 * header icon (see ChatsListScreen) rather than a tab of its own, now that
 * More is the account menu (Profile/Settings/Dark Theme/Sign out), not a
 * feature grid.
 */
export function WorkspaceScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: mailPage } = useMailInbox();
  const { data: channels } = useChannels();

  const mailUnread = mailPage?.items.reduce((sum, it) => sum + it.unreadCount, 0) ?? 0;
  const channelsUnread = channels?.reduce((sum, c) => sum + c.unread, 0) ?? 0;

  const items: Item[] = [
    { key: 'mail', label: 'Mail', icon: Mail, badge: mailUnread, onPress: (nav) => nav.navigate('Mail') },
    { key: 'channels', label: 'Channels', icon: Hash, badge: channelsUnread, onPress: (nav) => nav.navigate('Channels') },
    { key: 'members', label: 'Members', icon: Users, onPress: (nav) => nav.navigate('Members') },
    { key: 'org', label: 'Org', icon: Building2, onPress: (nav) => nav.navigate('Org') },
  ];

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Workspace</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <OrgSwitcherCard />

        <Card noPadding>
          {items.map((item, i) => (
            <View key={item.key}>
              <ListRow
                leading={
                  <View style={styles.iconWrap}>
                    <item.icon size={18} color={colors.accent} />
                  </View>
                }
                title={item.label}
                trailing={item.badge ? <Badge count={item.badge} /> : undefined}
                onPress={() => item.onPress(navigation)}
              />
              {i < items.length - 1 ? <View style={styles.divider} /> : null}
            </View>
          ))}
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
      paddingVertical: spacing.md,
    },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing['2xl'] },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.accentSoft,
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
