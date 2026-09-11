import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Logo } from '../../components/Logo';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';
// Metro/TS resolve JSON imports statically (resolveJsonModule) — the same
// real, already-existing version string apps/mobile ships under.
import pkg from '../../../package.json';

type Props = NativeStackScreenProps<MoreStackParamList, 'About'>;

export function AboutScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>About BlissWork</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.content}>
        <Logo size={56} />
        <Text style={styles.appName}>BlissWork</Text>
        <Text style={styles.version}>Version {pkg.version} · mobile</Text>
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
    content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
    appName: { fontSize: 18, fontWeight: '700', color: colors.fg, marginTop: spacing.md },
    version: { fontSize: 13, color: colors.muted },
  });
}
