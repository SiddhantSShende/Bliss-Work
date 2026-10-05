import { useMemo, useState } from 'react';
import { ArrowLeft, Hash, Lock } from 'lucide-react-native';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { UserDTO } from '@taskboard/shared';
import { useDirectory } from '../../hooks/useDirectory';
import { useAddChannelMembers, useCreateChannel } from '../../hooks/useChannels';
import { Avatar } from '../../components/Avatar';
import { Checkbox } from '../../components/Checkbox';
import { SearchInput } from '../../components/SearchInput';
import { TextField } from '../../components/TextField';
import { Button } from '../../components/Button';
import { spacing, radius, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'CreateChannel'>;

/**
 * Create Channel — name, description-free (ChannelDTO has no description
 * field, see ChannelDetailScreen's own note), Public/Private, and a real
 * member-search picker over the org directory, backed by `api.createChannel`.
 *
 * When opened with `addToChannelId` (from ChannelMembersScreen's "Add
 * Members" button) this becomes the SAME picker in "add to an existing
 * channel" mode: name/description/type are hidden, and the button calls
 * `api.addChannelMembers` instead — one picker, not two near-identical ones.
 */
export function CreateChannelScreen({ route, navigation }: Props) {
  const addToChannelId = route.params?.addToChannelId;
  const addToChannelName = route.params?.addToChannelName;
  const isAddMode = Boolean(addToChannelId);

  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { filtered, isLoading } = useDirectory(query);
  const create = useCreateChannel();
  const addMembers = useAddChannelMembers(addToChannelId ?? '');

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (isAddMode) {
      if (selected.size === 0) return Alert.alert('Pick at least one person to add');
      addMembers.mutate([...selected], {
        onSuccess: () => navigation.goBack(),
        onError: () => Alert.alert('Could not add members', 'Please try again.'),
      });
      return;
    }
    if (!name.trim()) return Alert.alert('Give the channel a name');
    create.mutate(
      { name: name.trim(), memberIds: [...selected], isLocked: isPrivate },
      {
        onSuccess: () => navigation.goBack(),
        onError: () => Alert.alert('Could not create channel', 'Please try again.'),
      },
    );
  };

  const busy = isAddMode ? addMembers.isPending : create.isPending;

  const renderPerson = (user: UserDTO) => (
    <Pressable onPress={() => toggle(user.id)} style={styles.personRow}>
      <Avatar name={user.displayName} src={user.avatarUrl} size={40} />
      <Text style={styles.personName} numberOfLines={1}>
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
        <Text style={styles.headerTitle}>{isAddMode ? `Add to ${addToChannelName}` : 'Create Channel'}</Text>
        <View style={{ width: 22 }} />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.form}>
            {!isAddMode ? (
              <>
                <View style={styles.iconPreview}>
                  <Hash size={32} color={colors.accent} />
                </View>
                <TextField
                  label="Channel Name"
                  value={name}
                  onChangeText={setName}
                  placeholder="e.g. Design Team"
                  maxLength={80}
                />
                <Text style={styles.label}>Channel Type</Text>
                <View style={styles.typeRow}>
                  <Pressable
                    onPress={() => setIsPrivate(false)}
                    style={[styles.typeCard, !isPrivate && styles.typeCardActive]}
                  >
                    <Hash size={18} color={!isPrivate ? colors.accent : colors.muted} />
                    <Text style={[styles.typeTitle, !isPrivate && { color: colors.accent }]}>Public</Text>
                    <Text style={styles.typeSubtitle}>Visible to everyone</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setIsPrivate(true)}
                    style={[styles.typeCard, isPrivate && styles.typeCardActive]}
                  >
                    <Lock size={18} color={isPrivate ? colors.accent : colors.muted} />
                    <Text style={[styles.typeTitle, isPrivate && { color: colors.accent }]}>Private</Text>
                    <Text style={styles.typeSubtitle}>Invite only</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
            <Text style={styles.label}>{isAddMode ? 'Add Members' : `Add Members${selected.size ? ` (${selected.size})` : ''} (optional)`}</Text>
            <SearchInput value={query} onChangeText={setQuery} placeholder="Search members..." />
          </View>
        }
        renderItem={({ item }) => renderPerson(item)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={isLoading ? undefined : <Text style={styles.emptyText}>No matches.</Text>}
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Button
          title={isAddMode ? 'Add Members' : 'Create Channel'}
          onPress={submit}
          loading={busy}
        />
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
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    form: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.sm },
    iconPreview: {
      alignSelf: 'center',
      width: 72,
      height: 72,
      borderRadius: 20,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
    },
    label: { fontSize: 13, fontWeight: '600', color: colors.fg },
    typeRow: { flexDirection: 'row', gap: spacing.sm },
    typeCard: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.card,
      padding: spacing.md,
      gap: 2,
    },
    typeCardActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
    typeTitle: { fontSize: 14, fontWeight: '700', color: colors.fg, marginTop: spacing.xs },
    typeSubtitle: { fontSize: 11, color: colors.muted },
    list: { paddingBottom: spacing['2xl'] },
    emptyText: { fontSize: 13, color: colors.muted, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    personRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    personName: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.fg },
    footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  });
}
