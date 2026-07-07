/**
 * Centralized asset exports for the BlissWork application.
 * Use these constants instead of hardcoding asset paths.
 */

export const ASSETS = {
  /** BlissWork brand logo - used throughout all apps */
  logo: '/assets/logo.png',
} as const;

export type AssetKey = keyof typeof ASSETS;
