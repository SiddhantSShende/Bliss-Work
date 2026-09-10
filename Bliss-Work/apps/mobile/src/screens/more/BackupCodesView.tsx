import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Checkbox } from '../../components/Checkbox';
import { Button } from '../../components/Button';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/**
 * Mirrors packages/app/src/features/BackupCodesView.tsx (web): shown exactly
 * once, right after enrollment or a regeneration — the server never returns
 * a backup code again after this response. Requires an explicit "I've saved
 * these" acknowledgement before Done is enabled, same as web, since losing
 * this screen unacknowledged is an account-recovery dead end.
 */
export function BackupCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [ack, setAck] = useState(false);

  return (
    <View style={styles.container}>
      <Text style={styles.muted}>
        Save these backup codes somewhere safe. Each one lets you sign in ONE time if you lose access to your
        authenticator — they will not be shown again.
      </Text>
      <View style={styles.grid}>
        {codes.map((code) => (
          <Text key={code} style={styles.code} selectable>
            {code}
          </Text>
        ))}
      </View>
      <View style={styles.ackRow}>
        <Checkbox checked={ack} onPress={() => setAck((v) => !v)} />
        <Text style={styles.ackText}>I've saved these codes somewhere safe.</Text>
      </View>
      <Button title="Done" onPress={onDone} disabled={!ack} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { gap: spacing.md },
    muted: { fontSize: 13, color: colors.muted },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      backgroundColor: colors.surface2,
      borderRadius: 12,
      padding: spacing.md,
    },
    code: { width: '45%', fontSize: 14, fontWeight: '600', color: colors.fg, fontVariant: ['tabular-nums'] },
    ackRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    ackText: { flex: 1, fontSize: 14, color: colors.fg },
  });
}
