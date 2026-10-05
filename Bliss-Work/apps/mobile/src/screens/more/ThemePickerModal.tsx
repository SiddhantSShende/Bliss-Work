import { useMemo } from 'react';
import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Modal } from '../../components/Modal';
import { withAlpha } from '../../lib/color';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useAppTheme } from '../../theme/ThemeProvider';
import { FAMILIES, MODES, artFor, paletteFor, type ThemeFamily, type ThemeMode } from '../../theme/themes';

/**
 * Settings → Theme: a Light / Dark switch, then the six BlissWork themes, each shown as a live miniature of
 * itself (in the chosen mode) (its own atmosphere, a glass card, its accent) so a person sees what
 * they are choosing. Picking one restyles the whole running app at once and is
 * remembered across restarts (ThemeProvider).
 */
export function ThemePickerModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, family, mode, setFamily, setMode } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Modal visible={visible} onClose={onClose} title="Theme" maxHeight="80%" variant="center">
      <View style={styles.modeRow} accessibilityRole="radiogroup">
        {MODES.map((m) => (
          <ModeButton key={m.id} mode={m.id} active={m.id === mode} onPress={() => setMode(m.id)} styles={styles} />
        ))}
      </View>
      {FAMILIES.map((opt) => {
        const selected = opt.id === family;
        return (
          <Pressable
            key={opt.id}
            onPress={() => setFamily(opt.id)}
            style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.pressed]}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={opt.name}
          >
            <ThemePreview familyId={opt.id} mode={mode} />
            <View style={styles.text}>
              <Text style={styles.name}>{opt.name}</Text>
              <Swatches familyId={opt.id} mode={mode} />
            </View>
            {selected ? (
              <View style={styles.check}>
                <Check size={14} color={colors.accentFg} />
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </Modal>
  );
}

function ModeButton({ mode, active, onPress, styles }: { mode: ThemeMode; active: boolean; onPress: () => void; styles: ReturnType<typeof createStyles> }) {
  const label = mode === 'light' ? 'Light' : 'Dark';
  return (
    <Pressable
      onPress={onPress}
      style={[styles.modeBtn, active && styles.modeBtnActive]}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label} mode`}
    >
      <Text style={[styles.modeText, active && styles.modeTextActive]}>{label}</Text>
    </Pressable>
  );
}

/** A miniature of one theme, painted with THAT theme's own palette and atmosphere (not the active one). */
function ThemePreview({ familyId, mode }: { familyId: ThemeFamily; mode: ThemeMode }) {
  const p = paletteFor(familyId, mode);
  const art = artFor(familyId, mode);
  return (
    <View style={[previewStyles.wrap, { borderColor: p.border }]}>
      <LinearGradient colors={art.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {art.blobs.slice(0, 2).map((b, i) => (
        <View
          key={i}
          style={[
            previewStyles.blob,
            { backgroundColor: withAlpha(b.color, Math.min(0.6, b.opacity)), left: i === 0 ? '52%' : '-18%', top: i === 0 ? '-40%' : '38%' },
          ]}
        />
      ))}
      <View style={[previewStyles.card, { backgroundColor: p.surface, borderColor: p.borderHighlight }]}>
        <View style={[previewStyles.line, { backgroundColor: p.fg, width: '62%' }]} />
        <View style={[previewStyles.line, { backgroundColor: p.muted, width: '38%', height: 3 }]} />
        <View style={[previewStyles.dot, { backgroundColor: p.accent }]} />
      </View>
      <View style={[previewStyles.nav, { backgroundColor: p.navigation, borderColor: p.border }]}>
        <View style={[previewStyles.navDot, { backgroundColor: p.accent }]} />
        <View style={[previewStyles.navDot, { backgroundColor: p.muted }]} />
        <View style={[previewStyles.navDot, { backgroundColor: p.muted }]} />
      </View>
    </View>
  );
}

function Swatches({ familyId, mode }: { familyId: ThemeFamily; mode: ThemeMode }) {
  const p = paletteFor(familyId, mode);
  return (
    <View style={swatchStyles.row}>
      {[p.bgSolid, p.accentSecondary, p.accent].map((c, i) => (
        <View key={i} style={[swatchStyles.dot, { backgroundColor: c, borderColor: p.border }]} />
      ))}
    </View>
  );
}

const previewStyles = StyleSheet.create({
  wrap: { width: 88, height: 72, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  blob: { position: 'absolute', width: '70%', aspectRatio: 1, borderRadius: 999 },
  card: { position: 'absolute', left: 8, right: 8, top: 8, height: 30, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth * 2, padding: 6, gap: 4 },
  line: { height: 4, borderRadius: 2 },
  dot: { position: 'absolute', right: 6, bottom: 5, width: 7, height: 7, borderRadius: 4 },
  nav: { position: 'absolute', left: 10, right: 10, bottom: 6, height: 16, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth * 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  navDot: { width: 6, height: 6, borderRadius: 3 },
});

const swatchStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, marginTop: 6 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1 },
});

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    modeRow: {
      flexDirection: 'row',
      padding: 3,
      marginBottom: spacing.md,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: colors.border,
      backgroundColor: colors.input,
    },
    modeBtn: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.pill },
    modeBtnActive: { backgroundColor: colors.accent },
    modeText: { fontSize: 14, fontWeight: '600', color: colors.muted },
    modeTextActive: { color: colors.accentFg },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.sm,
      marginBottom: spacing.sm,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    rowSelected: { borderColor: colors.accent, backgroundColor: colors.selected },
    pressed: { opacity: 0.75 },
    text: { flex: 1 },
    name: { fontSize: 16, fontWeight: '700', color: colors.fg },
    check: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  });
}
