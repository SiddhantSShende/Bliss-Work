import { useMemo } from 'react';
import { Modal as RNModal, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface ModalProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Fraction of screen height the sheet may grow to before its content
   *  scrolls internally — sensible per-caller default is 80%. */
  maxHeight?: `${number}%`;
  contentStyle?: ViewStyle;
}

/**
 * Shared bottom sheet: backdrop + rounded sheet + optional drag handle/title.
 * Extracted from the near-identical Modal markup that NotificationsSheet,
 * OrgSwitcherCard, and MfaSettingsScreen's step-up dialog each hand-rolled
 * separately — one shared primitive instead of three copies, per the app's
 * design-consistency goal. Those call sites are unchanged for now (Phase 1 is
 * foundations only); new sheets (the theme picker, the workspace switcher)
 * are built on this one.
 */
export function Modal({ visible, onClose, title, children, maxHeight = '80%', contentStyle }: ModalProps) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <RNModal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { maxHeight, paddingBottom: insets.bottom + spacing.lg }, contentStyle]}>
        <View style={styles.handle} />
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {children}
      </View>
    </RNModal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.card,
      borderTopRightRadius: radius.card,
      paddingTop: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    handle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: spacing.sm,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: colors.fg,
      marginBottom: spacing.md,
    },
  });
}
