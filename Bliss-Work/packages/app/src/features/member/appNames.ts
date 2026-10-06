/**
 * Executable name → the application's proper name, for DISPLAY only.
 *
 * Telemetry stores exactly what the desktop tracker saw (`chrome.exe`) as the
 * row's target, and that never changes — the rollups group on it. This is the
 * one place it becomes words, alongside activityLabels, so a mapping can be
 * added or corrected without touching a stored row.
 *
 * It is a lookup rather than a read of the exe's Windows version info
 * (FileDescription) because the person looking at a timeline is usually not the
 * person it describes: an admin's machine cannot inspect a file on a member's.
 * Reading it at capture time would mean sending a new field with every span,
 * which is a telemetry change this deliberately avoids.
 *
 * Anything not listed gets a readable fallback, so a new application degrades
 * to "Slack" or "Windows Terminal" rather than "slack.exe".
 */

/** Keyed by lower-cased file name. */
const KNOWN_APPS: Record<string, string> = {
  "chrome.exe": "Google Chrome",
  "msedge.exe": "Microsoft Edge",
  "firefox.exe": "Mozilla Firefox",
  "brave.exe": "Brave",
  "opera.exe": "Opera",
  "code.exe": "Visual Studio Code",
  "devenv.exe": "Visual Studio",
  "winword.exe": "Microsoft Word",
  "excel.exe": "Microsoft Excel",
  "powerpnt.exe": "Microsoft PowerPoint",
  "outlook.exe": "Microsoft Outlook",
  "onenote.exe": "Microsoft OneNote",
  "msaccess.exe": "Microsoft Access",
  "teams.exe": "Microsoft Teams",
  "ms-teams.exe": "Microsoft Teams",
  "explorer.exe": "File Explorer",
  "notepad.exe": "Notepad",
  "calc.exe": "Calculator",
  "mspaint.exe": "Paint",
  "cmd.exe": "Command Prompt",
  "powershell.exe": "Windows PowerShell",
  "pwsh.exe": "PowerShell",
  "windowsterminal.exe": "Windows Terminal",
  "taskmgr.exe": "Task Manager",
  "acrord32.exe": "Adobe Acrobat Reader",
  "acrobat.exe": "Adobe Acrobat",
  "zoom.exe": "Zoom",
  "slack.exe": "Slack",
  "discord.exe": "Discord",
  "spotify.exe": "Spotify",
  "whatsapp.exe": "WhatsApp",
  "telegram.exe": "Telegram",
  "postman.exe": "Postman",
  "figma.exe": "Figma",
  "blisswork.exe": "BlissWork",
};

/** Extensions an executable or app bundle may carry. */
const EXECUTABLE_EXT = /\.(exe|app|bin|com|msi|scr)$/i;

/** The last segment of a Windows or POSIX path. The tracker sends a bare name,
 *  but a stored row or a future payload could carry the full path. */
function baseName(raw: string): string {
  const parts = raw.trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** "WindowsTerminal" → "Windows Terminal"; "my-cool_app" → "My Cool App". */
function readable(stem: string): string {
  return stem
    // A lone leading lower-case letter (iTunes, eBay) is a brand's own style,
    // not a word boundary.
    .replace(/([a-z0-9])([A-Z])/g, (m, a: string, b: string, offset: number) =>
      offset === 0 && /[a-z]/.test(a) ? m : `${a} ${b}`,
    )
    .replace(/[-_.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const shouted = word === word.toUpperCase();
      // Short all-caps words are acronyms (VLC, SSH) and stay as they are.
      if (shouted && word.length <= 4) return word;
      // A long all-caps one is just a shouted file name (SOFFICE); lower-case is
      // an unstyled one. Mixed case (iTunes) was chosen by someone, so it stays.
      if (shouted || word === word.toLowerCase()) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word;
    })
    .join(" ");
}

/**
 * The display name for an executable name (or path). Never returns an empty
 * string for a non-empty input, and never a trailing `.exe` unless the name was
 * nothing but the extension.
 */
export function resolveAppName(executable: string): string {
  const file = baseName(executable);
  if (!file) return executable.trim();
  const known = KNOWN_APPS[file.toLowerCase()];
  if (known) return known;
  const stem = file.replace(EXECUTABLE_EXT, "");
  return readable(stem) || file;
}
