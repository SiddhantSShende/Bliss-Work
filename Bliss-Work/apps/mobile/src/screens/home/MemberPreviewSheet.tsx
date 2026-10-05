import { useMemo } from 'react';
import { Mail, MessageCircle, Phone, ShieldCheck, Video } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UserDTO } from '@taskboard/shared';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/Modal';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface Props {
  member: UserDTO | null;
  online: boolean;
  onClose: () => void;
  onMessage: (member: UserDTO) => void;
  onCall: (member: UserDTO, media: 'audio' | 'video') => void;
}

/**
 * Member preview on the glass sheet: what the workspace directory already
 * returns for a colleague (photo, name, presence, role, email) plus the contact
 * actions the app really supports — Message (opens the DM) and in-app voice /
 * video call. Nothing here comes from a request the caller isn't allowed to make.
 */
export function MemberPreviewSheet({ member, online, onClose, onMessage, onCall }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isAdmin = member?.roles.includes('org_admin') ?? false;

  return (
    <Modal visible={member !== null} onClose={onClose} title="Member" variant="center">
      {member ? (
        <View style={styles.wrap}>
          <Avatar name={member.displayName} src={member.avatarUrl} size={88} online={online} />
          <Text style={styles.name} numberOfLines={2}>
            {member.displayName}
          </Text>
          <View style={styles.tags}>
            <View style={[styles.tag, online && styles.tagOnline]}>
              <View style={[styles.dot, { backgroundColor: online ? colors.success : colors.muted }]} />
              <Text style={styles.tagText}>{online ? 'Online' : 'Offline'}</Text>
            </View>
            <View style={styles.tag}>
              {isAdmin ? <ShieldCheck size={13} color={colors.accent} /> : null}
              <Text style={styles.tagText}>{isAdmin ? 'Admin' : 'Member'}</Text>
            </View>
          </View>

          <View style={styles.info}>
            <Mail size={16} color={colors.muted} />
            <Text style={styles.infoText} numberOfLines={1} selectable>
              {member.email}
            </Text>
          </View>

          <View style={styles.actions}>
            <Action icon={MessageCircle} label="Message" onPress={() => onMessage(member)} colors={colors} primary />
            <Action icon={Phone} label="Voice" onPress={() => onCall(member, 'audio')} colors={colors} />
            <Action icon={Video} label="Video" onPress={() => onCall(member, 'video')} colors={colors} />
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

function Action({ icon: Icon, label, onPress, colors, primary }: { icon: typeof Phone; label: string; onPress: () => void; colors: ThemeColors; primary?: boolean }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} style={[styles.action, primary && styles.actionPrimary]} accessibilityRole="button" accessibilityLabel={label}>
      <Icon size={18} color={primary ? colors.accentFg : colors.accent} />
      <Text style={[styles.actionText, primary && { color: colors.accentFg }]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
    name: { fontSize: 20, fontWeight: '700', color: colors.fg, textAlign: 'center', marginTop: spacing.xs },
    tags: { flexDirection: 'row', gap: spacing.sm },
    tag: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.surface2 },
    tagOnline: { backgroundColor: colors.accentSoft },
    tagText: { fontSize: 12, fontWeight: '600', color: colors.fg },
    dot: { width: 7, height: 7, borderRadius: 4 },
    info: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: '100%', marginTop: spacing.xs },
    infoText: { fontSize: 14, color: colors.muted, flexShrink: 1 },
    actions: { flexDirection: 'row', gap: spacing.sm, alignSelf: 'stretch', marginTop: spacing.md },
    action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.md, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
    actionPrimary: { backgroundColor: colors.accent },
    actionText: { fontSize: 14, fontWeight: '600', color: colors.accent },
  });
}
