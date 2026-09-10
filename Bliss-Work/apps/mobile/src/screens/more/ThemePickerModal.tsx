import { useMemo } from 'react';
import { Check, Moon, Sun } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Modal } from '../../components/Modal';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useAppTheme, useThemeColors } from '../../theme/ThemeProvider';
import { FAMILIES, paletteFor, type ThemeFamily } from '../../theme/themes';

/**
 * Settings → Theme's picker: Light/Dark appearance + one of the app's 6
 * named accent families — the RN counterpart of web's Settings ThemeMenu
 * (packages/app/src/routes/Settings.tsx). Built on the shared `Modal`
 * primitive (Phase 1 foundation) rather than another hand-rolled sheet.
 * Selecting a family preserves the current Light/Dark choice, same as web —
 * picking an accent must never silently flip appearance back to Light.
 */
export function ThemePickerModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { family, isDark, setFamily, setMode } = useAppTheme();

  return (
    <Modal visible={visible} onClose={onClose} title="Theme" maxHeight="75%">
      <View style={styles.segment}>
        <Pressable onPress={() => setMode('light')} style={[styles.segmentBtn, !isDark && { backgroundColor: colors.accent }]}>
          <Sun size={14} color={!isDark ? colors.accentFg : colors.muted} />
          <Text style={[styles.segmentText, !isDark && { color: colors.accentFg }]}>Light</Text>
        </Pressable>
        <Pressable onPress={() => setMode('dark')} style={[styles.segmentBtn, isDark && { backgroundColor: colors.accent }]}>
          <Moon size={14} color={isDark ? colors.accentFg : colors.muted} />
          <Text style={[styles.segmentText, isDark && { color: colors.accentFg }]}>Dark</Text>
        </Pressable>
      </View>

      <View style={styles.divider} />

      {FAMILIES.map((opt) => (
        <Pressable key={opt.id} onPress={() => setFamily(opt.id)} style={styles.row}>
          <ThemeSwatch familyId={opt.id} dark={isDark} />
          <Text style={styles.rowLabel}>{opt.name}</Text>
          {opt.id === family ? <Check size={18} color={colors.accent} /> : null}
        </Pressable>
      ))}
    </Modal>
  );
}

/** A 4-color miniature preview of one family, independent of the currently
 *  active theme — rendered with THAT family's own palette (at the current
 *  light/dark mode) so a person can see what they're about to pick. Mirrors
 *  web's own ThemeSwatch (bg/surface-2/surface + brand-gradient dot). */
function ThemeSwatch({ familyId, dark }: { familyId: ThemeFamily; dark: boolean }) {
  const p = paletteFor(familyId, dark);
  return (
    <View style={[swatchStyles.wrap, { backgroundColor: p.bg, borderColor: p.border }]}>
      <View style={[swatchStyles.rail, { backgroundColor: p.surface2 }]} />
      <View style={[swatchStyles.pane, { backgroundColor: p.surface }]}>
        <LinearGradient
          colors={[p.brandFrom, p.brandTo]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={swatchStyles.dot}
        />
      </View>
    </View>
  );
}

const swatchStyles = StyleSheet.create({
  wrap: {
    width: 52,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  rail: { width: 12, height: '100%' },
  pane: { flex: 1, alignItems: 'flex-end', justifyContent: 'flex-end', padding: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    segment: {
      flexDirection: 'row',
      gap: spacing.xs,
      backgroundColor: colors.surface2,
      borderRadius: radius.pill,
      padding: 3,
      marginBottom: spacing.md,
    },
    segmentBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
    },
    segmentText: { fontSize: 13, fontWeight: '600', color: colors.muted },
    divider: { height: 1, backgroundColor: colors.border, marginBottom: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    rowLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.fg },
  });
}
