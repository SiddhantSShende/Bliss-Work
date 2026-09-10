import { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: number;
  /** Renders a small dot in the bottom-right corner — omitted entirely when
   *  undefined, since "known offline" and "presence not tracked here" must
   *  render differently (a chat row knows presence, a Members row might not). */
  online?: boolean;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Circular profile photo, or initials on an accent-soft background when the
 *  user has none — same fallback contract as web's `Avatar` (`UserDTO.avatarUrl`
 *  is `null` until someone uploads a photo, never a broken-image URL). */
export function Avatar({ name, src, size = 44, online }: AvatarProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const dim = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={{ width: size, height: size }}>
      {src ? (
        <Image source={{ uri: src }} style={dim} />
      ) : (
        <View style={[styles.fallback, dim]}>
          <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{initialsOf(name)}</Text>
        </View>
      )}
      {online !== undefined ? (
        <View
          style={[
            styles.dot,
            {
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: (size * 0.28) / 2,
              backgroundColor: online ? colors.success : colors.border,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    fallback: {
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    initials: {
      color: colors.accent,
      fontWeight: '700',
    },
    dot: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      borderWidth: 2,
      borderColor: colors.surface,
    },
  });
}
