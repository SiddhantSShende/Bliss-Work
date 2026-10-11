import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react-native';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { CaptchaState } from '../hooks/useCaptcha';
import { spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { TextField } from './TextField';

/** RN equivalent of packages/app/src/features/Captcha.tsx's CaptchaField —
 *  the server hands back a base64 data: URI (CaptchaChallengeDTO.captchaImage),
 *  which <Image source={{ uri }}> renders directly with no extra library. */
export function CaptchaField({ captcha }: { captcha: CaptchaState }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <Text style={styles.label}>Security check</Text>
      <View style={styles.row}>
        <View style={styles.imageBox}>
          {captcha.imageUrl ? (
            <Image
              source={{ uri: captcha.imageUrl }}
              style={styles.image}
              resizeMode="contain"
              accessible
              accessibilityLabel="Security check image"
            />
          ) : (
            <ActivityIndicator color={colors.muted} size="small" />
          )}
        </View>
        <Pressable
          onPress={() => void captcha.refresh()}
          disabled={captcha.loading}
          style={styles.refreshButton}
          accessibilityRole="button"
          accessibilityLabel="Refresh security check"
          accessibilityState={{ disabled: captcha.loading }}
          hitSlop={8}
        >
          <RefreshCw size={20} color={colors.muted} />
        </Pressable>
      </View>
      <TextField
        value={captcha.value}
        onChangeText={captcha.setValue}
        placeholder="Enter the characters shown above"
        maxLength={32}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="CAPTCHA answer"
        accessibilityHint="Upper and lower case letters are different."
      />
      <Text style={styles.hint}>Upper and lower case letters are different.</Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { gap: spacing.xs },
    label: { fontSize: 13, fontWeight: '600', color: colors.muted },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    // Same 300:90 ratio the server renders at; `contain` so nothing is cropped.
    imageBox: {
      flex: 1,
      maxWidth: 300,
      aspectRatio: 300 / 90,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    image: { height: '100%', width: '100%' },
    refreshButton: { padding: spacing.sm },
    hint: { fontSize: 12, color: colors.muted },
  });
}
