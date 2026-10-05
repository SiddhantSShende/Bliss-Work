import { useMemo, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SearchInput } from '../../components/SearchInput';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';
import { ChannelsTabView } from '../chats/ChannelsTabView';

type Props = NativeStackScreenProps<MoreStackParamList, 'Channels'>;

/** Channels reached from More → Channels: Back, create, search, and the shared channel list. */
export function ChannelsListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8} accessibilityLabel="Back">
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Channels</Text>
        <Pressable onPress={() => navigation.navigate('CreateChannel', undefined)} style={styles.addButton} hitSlop={8} accessibilityLabel="Create channel">
          <Plus size={20} color={colors.accentFg} />
        </Pressable>
      </View>
      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search channels..." />
      </View>
      <ChannelsTabView navigation={navigation as any} query={query} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    addButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  });
}
