import { useMemo } from 'react';
import { AlertTriangle, ArrowLeft, Building2 } from 'lucide-react-native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { Card } from '../../components/Card';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MoreStackParamList, 'Org'>;

/** Read-only org detail: name, slug, and a pending-deletion notice if one
 *  exists. Deliberately no delete/cancel-delete actions here — that's an
 *  admin-only, destructive capability the redesign's spec never asked for;
 *  adding it would be scope creep beyond a presentation-layer change. */
export function OrgScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const { data: org, isLoading } = useQuery({ queryKey: ['orgLifecycle'], queryFn: () => api.org() });

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Organization</Text>
        <View style={{ width: 22 }} />
      </View>

      {isLoading || !org ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Card style={styles.card}>
            <View style={styles.iconWrap}>
              <Building2 size={22} color={colors.accent} />
            </View>
            <Text style={styles.name}>{org.name}</Text>
            {org.slug ? <Text style={styles.slug}>{org.slug}</Text> : null}
          </Card>

          {org.deleteRequestedAt ? (
            <Card style={styles.warningCard}>
              <AlertTriangle size={18} color={colors.warning} />
              <Text style={styles.warningText}>
                Deletion requested{org.purgeAfter ? ` — permanent after ${new Date(org.purgeAfter).toLocaleDateString()}` : ''}.
                Manage this from the BlissWork web app.
              </Text>
            </Card>
          ) : null}
        </ScrollView>
      )}
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
    spinner: { marginTop: spacing['2xl'] },
    content: { padding: spacing.lg, gap: spacing.md },
    card: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
    iconWrap: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
    },
    name: { fontSize: 18, fontWeight: '700', color: colors.fg },
    slug: { fontSize: 13, color: colors.muted },
    warningCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      backgroundColor: '#fffbeb',
      borderColor: colors.warning,
    },
    warningText: { flex: 1, fontSize: 13, color: colors.fg, lineHeight: 18 },
  });
}
