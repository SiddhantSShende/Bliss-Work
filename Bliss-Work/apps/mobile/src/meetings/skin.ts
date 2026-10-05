import { useMemo } from 'react';
import { useAppTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../lib/color';
import { mix } from './mix';

/**
 * The meeting screen is a dark video stage in every theme (video reads best on
 * dark and the reference design is dark), tinted with the active BlissWork
 * theme's brand colours so all six themes still look like themselves: the
 * gradient, the accent buttons, the speaking ring and the glass tint all come
 * from the palette.
 */

const BASE = '#070a14';

export interface MeetingSkin {
  /** Stage gradient (top -> bottom). */
  gradient: readonly [string, string];
  /** Glass panel fill over the blur. */
  glass: string;
  glassBorder: string;
  /** Solid surface for tiles that have no video. */
  tile: string;
  tileBorder: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  danger: string;
  success: string;
  scrim: string;
}

export function useMeetingSkin(): MeetingSkin {
  const { colors } = useAppTheme();
  return useMemo<MeetingSkin>(
    () => ({
      gradient: [mix(BASE, colors.brandTo, 0.24), mix(BASE, colors.brandFrom, 0.06)],
      glass: withAlpha(mix(BASE, colors.accent, 0.1), 0.62),
      glassBorder: withAlpha('#ffffff', 0.16),
      tile: mix(BASE, colors.accent, 0.14),
      tileBorder: withAlpha('#ffffff', 0.1),
      ink: '#ffffff',
      muted: withAlpha('#ffffff', 0.66),
      faint: withAlpha('#ffffff', 0.42),
      accent: colors.accent,
      accentInk: colors.accentFg,
      accentSoft: withAlpha(colors.accent, 0.22),
      danger: '#ef4444',
      success: '#22c55e',
      scrim: 'rgba(3,6,14,0.5)',
    }),
    [colors],
  );
}
