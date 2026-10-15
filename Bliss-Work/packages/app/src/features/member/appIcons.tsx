/**
 * Simplified, locally-drawn brand badges for the handful of applications
 * common enough in Top Applications to be worth a real mark instead of the
 * neutral initial tile. Colors match each product's brand, but shapes are
 * hand-simplified (not a copy of the vendor's vector files) to stay crisp at
 * the ~24px size this renders at.
 *
 * Keyed identically to appNames.ts's KNOWN_APPS (lower-cased executable file
 * name) so a lookup by the row's `key` lines up with the resolved display
 * name. Anything not listed here has no entry — callers fall back to the
 * existing initial tile.
 */
import type { ComponentType } from "react";

type IconProps = { size?: number; className?: string };

function VsCodeIcon({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="5" fill="#007ACC" />
      <path
        d="M9 7 L5 12 L9 17 M15 7 L19 12 L15 17"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChromeIcon({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path d="M12 12 L12 0 A12 12 0 0 1 22.39 18 Z" fill="#EA4335" />
      <path d="M12 12 L22.39 18 A12 12 0 0 1 1.61 18 Z" fill="#FBBC05" />
      <path d="M12 12 L1.61 18 A12 12 0 0 1 12 0 Z" fill="#34A853" />
      <circle cx="12" cy="12" r="7.2" fill="#fff" />
      <circle cx="12" cy="12" r="4.8" fill="#4285F4" />
    </svg>
  );
}

function TeamsIcon({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="5" fill="#5059C9" />
      <text
        x="11.5"
        y="13"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="13"
        fontWeight="700"
        fill="#fff"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"
      >
        T
      </text>
      <circle cx="17.3" cy="6.7" r="1.6" fill="#fff" />
    </svg>
  );
}

function PowerPointIcon({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="5" fill="#D24726" />
      <text
        x="12"
        y="13"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="13"
        fontWeight="700"
        fill="#fff"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"
      >
        P
      </text>
    </svg>
  );
}

function FileExplorerIcon({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        d="M2 6.5A1.5 1.5 0 0 1 3.5 5h5l2 2h10A1.5 1.5 0 0 1 22 8.5v10A1.5 1.5 0 0 1 20.5 20h-17A1.5 1.5 0 0 1 2 18.5Z"
        fill="#0A5FC7"
      />
      <path d="M2 9.8h20v8.7A1.5 1.5 0 0 1 20.5 20h-17A1.5 1.5 0 0 1 2 18.5Z" fill="#5EA0EF" />
    </svg>
  );
}

const APP_ICONS: Record<string, ComponentType<IconProps>> = {
  "code.exe": VsCodeIcon,
  "chrome.exe": ChromeIcon,
  "teams.exe": TeamsIcon,
  "ms-teams.exe": TeamsIcon,
  "powerpnt.exe": PowerPointIcon,
  "explorer.exe": FileExplorerIcon,
};

/** The last segment of a Windows or POSIX path, lower-cased — the same
 *  normalization appNames.ts applies before its KNOWN_APPS lookup. */
function baseKey(raw: string): string {
  const parts = raw.trim().split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/** A brand icon component for a known executable, or undefined so callers
 *  can fall back to the existing initial tile. */
export function getAppIcon(executable: string): ComponentType<IconProps> | undefined {
  return APP_ICONS[baseKey(executable)];
}
