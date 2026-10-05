import { useEffect, useMemo, useState } from 'react';
import { Bell, Menu, Plus, Search, X } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNotifications } from '../../hooks/useNotifications';
import { Logo } from '../../components/Logo';
import { Badge } from '../../components/Badge';
import { SearchInput } from '../../components/SearchInput';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { AppTabParamList, ChatsStackParamList } from '../../navigation/types';
import { NotificationsSheet } from './NotificationsSheet';

// The inner views
import { ChatsTabView } from './ChatsTabView';
import { ChannelsTabView } from './ChannelsTabView';
import { MailTabView } from './MailTabView';

type Props = NativeStackScreenProps<ChatsStackParamList, 'ChatsList'>;

export function ChatsListScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: notifications } = useNotifications();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  
  const [activeTab, setActiveTab] = useState<'chats' | 'channels' | 'mail'>(
    route.params?.tab === 'channels' || route.params?.tab === 'mail' ? route.params.tab : 'chats',
  );
  const rawTab = route.params?.tab as string | undefined;
  const requestedTab = rawTab === 'chats' || rawTab === 'channels' || rawTab === 'mail' ? rawTab : undefined;
  useEffect(() => {
    if (requestedTab) setActiveTab(requestedTab);
  }, [requestedTab]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const toggleSearch = () => {
    if (searchOpen) setQuery('');
    setSearchOpen((v) => !v);
  };
  const searchPlaceholder = `Search ${activeTab}...`;
  const notificationsUnread = notifications?.filter((n) => !n.read).length ?? 0;

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Pressable
            onPress={() => navigation.getParent<BottomTabNavigationProp<AppTabParamList>>()?.navigate('More', { screen: 'MoreMenu' })}
            hitSlop={8}
          >
            <Menu size={22} color={colors.fg} />
          </Pressable>
          <Logo size={22} />
          <Text style={styles.headerTitle}>Chats</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={toggleSearch} hitSlop={8} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={searchOpen ? 'Close search' : 'Search'}>
            {searchOpen ? <X size={22} color={colors.fg} /> : <Search size={22} color={colors.fg} />}
          </Pressable>
          <Pressable onPress={() => setNotificationsOpen(true)} hitSlop={8} style={styles.bell}>
            <Bell size={22} color={colors.fg} />
            {notificationsUnread > 0 ? (
              <View style={styles.bellBadge}>
                <Badge count={notificationsUnread} />
              </View>
            ) : null}
          </Pressable>
          <Pressable onPress={() => {
            if (activeTab === 'chats') navigation.navigate('NewChat');
            else if (activeTab === 'channels') navigation.navigate('CreateChannel');
          }} style={styles.addButton} hitSlop={8}>
            <Plus size={20} color={colors.accentFg} />
          </Pressable>
        </View>
      </View>

      {searchOpen ? (
        <View style={styles.searchWrap}>
          <SearchInput value={query} onChangeText={setQuery} placeholder={searchPlaceholder} autoFocus />
        </View>
      ) : null}

      <View style={styles.segmentedControlWrap}>
        <View style={[styles.segmentedControl, { backgroundColor: colors.surface2 }]}>
          <Pressable style={[styles.segmentBtn, activeTab === 'chats' && { backgroundColor: colors.accent }]} onPress={() => setActiveTab('chats')}>
            <Text style={[styles.segmentText, activeTab === 'chats' && styles.segmentTextActive]}>Chats</Text>
          </Pressable>
          <Pressable style={[styles.segmentBtn, activeTab === 'channels' && { backgroundColor: colors.accent }]} onPress={() => setActiveTab('channels')}>
            <Text style={[styles.segmentText, activeTab === 'channels' && styles.segmentTextActive]}>Channels</Text>
          </Pressable>
          <Pressable style={[styles.segmentBtn, activeTab === 'mail' && { backgroundColor: colors.accent }]} onPress={() => setActiveTab('mail')}>
            <Text style={[styles.segmentText, activeTab === 'mail' && styles.segmentTextActive]}>Mail</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.content}>
        {activeTab === 'chats' && <ChatsTabView navigation={navigation} query={query} />}
        {activeTab === 'channels' && <ChannelsTabView navigation={navigation} query={query} />}
        {activeTab === 'mail' && <MailTabView navigation={navigation} query={query} />}
      </View>

      <NotificationsSheet visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
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
      paddingBottom: spacing.sm,
    },
    brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    headerTitle: { fontSize: 22, fontWeight: '700', color: colors.fg },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    iconBtn: { padding: 4 },
    bell: { position: 'relative' },
    bellBadge: { position: 'absolute', top: -4, right: -6 },
    addButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    segmentedControlWrap: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      marginTop: spacing.xs,
    },
    segmentedControl: {
      flexDirection: 'row',
      borderRadius: radius.pill,
      padding: 4,
    },
    segmentBtn: {
      flex: 1,
      paddingVertical: 8,
      alignItems: 'center',
      borderRadius: radius.pill,
    },
    segmentText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.fg,
    },
    segmentTextActive: {
      color: colors.accentFg,
    },
    content: { flex: 1 },
  });
}
