import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, type MemberStatus } from '@taskboard/shared';
import { Card } from '../../../components/Card';
import { radius, spacing, type ThemeColors } from '../../../constants/theme';
import { useThemeColors } from '../../../theme/ThemeProvider';

/** True when the server refused the call for role reasons — surfaced as "no
 *  permission" rather than a generic failure, since retrying cannot help. */
export function isForbidden(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 403 || e.status === 401);
}

export function roleLabel(roles: readonly string[]): string {
  return roles.includes('org_admin') ? 'Admin' : 'Member';
}

export function statusLabel(status: MemberStatus): string {
  return status === 'active' ? 'Active' : status === 'suspended' ? 'Suspended' : 'Removed';
}

/** Tone of a status/state pill, resolved to theme colours by `Pill`. */
export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const fg =
    tone === 'success' ? colors.success
    : tone === 'warning' ? colors.warning
    : tone === 'danger' ? colors.danger
    : tone === 'accent' ? colors.accent
    : colors.muted;
  return (
    <View style={[styles.pill, { borderColor: fg }]}>
      <Text style={[styles.pillText, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function statusTone(status: MemberStatus): Tone {
  return status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'danger';
}

/** Label/value pair on the Overview and Security tabs. The value wraps rather
 *  than truncating: long emails must not push the page wider than the screen. */
export function InfoRow({ label, value, last }: { label: string; value: ReactNode; last?: boolean }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.infoRow, !last && styles.infoRowDivider]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <View style={styles.infoValueWrap}>
        {typeof value === 'string' ? <Text style={styles.infoValue}>{value}</Text> : value}
      </View>
    </View>
  );
}

/** Titled card with an optional hint line — the Admin/Security section shape. */
export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Card style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
      {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
    </Card>
  );
}

/** Pill-shaped action button; `danger` for destructive actions. The shared
 *  <Button> is full-width primary/ghost only, which doesn't fit inline rows. */
export function ActionButton({
  title,
  onPress,
  disabled,
  danger,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tint = danger ? colors.danger : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [styles.action, { borderColor: tint }, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
    >
      <Text style={[styles.actionText, { color: tint }]}>{title}</Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    pill: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 1, alignSelf: 'flex-start' },
    pillText: { fontSize: 11, fontWeight: '700' },
    infoRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.md },
    infoRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    infoLabel: { width: 108, fontSize: 14, color: colors.muted },
    infoValueWrap: { flex: 1, minWidth: 0, alignItems: 'flex-start' },
    infoValue: { fontSize: 14, color: colors.fg, flexShrink: 1 },
    section: { gap: spacing.sm },
    sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.fg },
    sectionHint: { fontSize: 12, lineHeight: 17, color: colors.muted },
    action: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    actionText: { fontSize: 13, fontWeight: '600' },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.85 },
  });
}
