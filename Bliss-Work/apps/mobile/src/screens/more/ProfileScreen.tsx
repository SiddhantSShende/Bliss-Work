import { useMemo, useState } from 'react';
import { ArrowLeft, Camera } from 'lucide-react-native';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/Card';
import { TextField } from '../../components/TextField';
import { Button } from '../../components/Button';
import { qk } from '../../hooks/queryKeys';
import { spacing, radius, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'Profile'>;

/**
 * Mirrors packages/app/src/routes/Profile.tsx (web): display-name edit,
 * profile photo, read-only email/username, role badge — same
 * `api.updateProfile`/`api.me` endpoint, same session store. The photo path
 * uses expo-image-picker's own JPEG quality compression as the size limit
 * instead of web's client-side canvas thumbnail (`lib/thumbnail.ts`) — RN has
 * no canvas to run that exact code, but the goal (a small, uniform upload
 * rather than a multi-MB phone photo) is the same.
 */
export function ProfileScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const qc = useQueryClient();
  const user = useSession((s) => s.user)!;
  const setUser = useSession((s) => s.setUser);
  const [name, setName] = useState(user.displayName);

  const dirty = name.trim().length > 0 && name.trim() !== user.displayName;
  const isAdmin = user.roles.includes('org_admin');

  const save = useMutation({
    mutationFn: () => api.updateProfile({ displayName: name.trim() }),
    onSuccess: (updated) => {
      setUser(updated);
      setName(updated.displayName);
      qc.invalidateQueries({ queryKey: qk.directory });
    },
    onError: () => Alert.alert('Could not update profile', 'Please try again.'),
  });

  const uploadPhoto = useMutation({
    mutationFn: (avatarUrl: string) => api.updateProfile({ avatarUrl }),
    onSuccess: (updated) => {
      setUser(updated);
      qc.invalidateQueries({ queryKey: qk.directory });
    },
    onError: () => Alert.alert("Could not update your photo", 'Please try again.'),
  });

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photo access needed', 'Allow photo library access in your device Settings to change your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      base64: true,
    });
    if (result.canceled || !result.assets[0]?.base64) return;
    const asset = result.assets[0];
    const mimeType = asset.mimeType ?? 'image/jpeg';
    uploadPhoto.mutate(`data:${mimeType};base64,${asset.base64}`);
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.content}>
        <Card style={styles.identityCard}>
          <View style={styles.avatarWrap}>
            <Avatar name={user.displayName} src={user.avatarUrl} size={72} />
            <Pressable onPress={pickPhoto} disabled={uploadPhoto.isPending} style={styles.cameraButton} hitSlop={8}>
              {uploadPhoto.isPending ? (
                <ActivityIndicator size="small" color={colors.accentFg} />
              ) : (
                <Camera size={14} color={colors.accentFg} />
              )}
            </Pressable>
          </View>
          <Text style={styles.displayName}>{user.displayName}</Text>
          <Text style={styles.username}>@{user.username}</Text>
          <View style={[styles.roleBadge, isAdmin ? styles.roleBadgeAdmin : styles.roleBadgeMember]}>
            <Text style={[styles.roleBadgeText, isAdmin ? styles.roleBadgeTextAdmin : styles.roleBadgeTextMember]}>
              {isAdmin ? 'Admin' : 'Member'}
            </Text>
          </View>
        </Card>

        <Card style={styles.formCard}>
          <TextField label="Display name" value={name} onChangeText={setName} placeholder="Your name" maxLength={80} />
          <ReadOnlyField colors={colors} label="Email" value={user.email} />
          <ReadOnlyField colors={colors} label="Username" value={`@${user.username}`} />
          <View style={styles.formActions}>
            <Button
              title="Cancel"
              variant="ghost"
              onPress={() => setName(user.displayName)}
              disabled={!dirty}
              style={styles.cancelButton}
            />
            <Button
              title="Save changes"
              onPress={() => save.mutate()}
              loading={save.isPending}
              disabled={!dirty}
              style={styles.saveButton}
            />
          </View>
        </Card>
      </View>
    </View>
  );
}

function ReadOnlyField({ colors, label, value }: { colors: ThemeColors; label: string; value: string }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View>
      <Text style={styles.readOnlyLabel}>{label}</Text>
      <Text style={styles.readOnlyValue}>{value}</Text>
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
    content: { padding: spacing.lg, gap: spacing.md },
    identityCard: { alignItems: 'center', gap: 4, paddingVertical: spacing.xl },
    avatarWrap: { position: 'relative' },
    cameraButton: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: colors.surface,
    },
    displayName: { fontSize: 17, fontWeight: '700', color: colors.fg, marginTop: spacing.sm },
    username: { fontSize: 13, color: colors.muted },
    roleBadge: {
      marginTop: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radius.pill,
    },
    roleBadgeAdmin: { backgroundColor: colors.accentSoft },
    roleBadgeMember: { backgroundColor: colors.surface2 },
    roleBadgeText: { fontSize: 11, fontWeight: '700' },
    roleBadgeTextAdmin: { color: colors.accent },
    roleBadgeTextMember: { color: colors.muted },
    formCard: { gap: spacing.md },
    readOnlyLabel: { fontSize: 13, fontWeight: '600', color: colors.fg },
    readOnlyValue: { fontSize: 14, color: colors.muted, marginTop: 2 },
    formActions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end', marginTop: spacing.xs },
    cancelButton: { paddingHorizontal: spacing.md },
    saveButton: { paddingHorizontal: spacing.lg },
  });
}
