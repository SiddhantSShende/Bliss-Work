/**
 * Per-provider setup guides for Connected accounts.
 *
 * Connecting an integration means pasting a bot token, a system-user token, a
 * phone number ID — values that live several clicks deep in someone else's
 * console. The steps to find them already existed in docs/INTEGRATIONS-SETUP.md,
 * which is exactly where nobody setting up an integration is looking. This puts
 * them next to the field they belong to.
 *
 * Shape and rendering deliberately mirror `VendorMeta` / `SetupDialog` in
 * WorkspaceApps.tsx — that flow already proved the pattern for the OAuth app
 * side, and two setup surfaces that look different for no reason is worse than
 * a little duplication. Content is plain inline strings: this repo has no i18n
 * layer, and inventing one for five step lists would be its own project.
 */
import { ExternalLink, TriangleAlert } from "lucide-react";

export interface ProviderGuide {
  /** Where the user goes to get these values. A list, because a setup can
   *  legitimately span more than one console — some providers' IDs and secrets
   *  live in the developer app, but its access token is minted in Business
   *  Settings, and sending someone to the wrong one wastes the most time. */
  consoles: { label: string; url: string }[];
  /** One action per step, imperative, in the order they happen. */
  steps: string[];
  /** The thing that bites people. Rendered in the warning callout. */
  warning?: string;
}

export const GUIDES: Record<string, ProviderGuide> = {
  slack: {
    consoles: [{ label: "Slack API dashboard", url: "https://api.slack.com/apps" }],
    steps: [
      "Create an app → From scratch, and pick your workspace.",
      "OAuth & Permissions → add the bot scopes chat:write, channels:read, users:read and im:history.",
      "Install to your workspace, then copy the Bot User OAuth Token (starts with xoxb-).",
      "Basic Information → copy the Signing Secret.",
      "Paste both below and connect. The connection then shows a webhook URL.",
      "Back in Slack: Event Subscriptions → enable, paste that URL, and wait for Verified.",
      "Subscribe to the bot events message.channels and message.im.",
    ],
    warning:
      "The webhook URL is unique to this connection — Slack's verification request carries no team id, so it's the only way we can find your signing secret before trusting the request.",
  },
  gmail: {
    consoles: [{ label: "Google Cloud Console", url: "https://console.cloud.google.com/apis/credentials" }],
    steps: [
      "Set up the Google workspace app first — Workspace apps → Google → Set up, above.",
      "Then click Connect here and sign in with the mailbox you want to link.",
      "Approve the requested access. Mail addressed to that mailbox starts counting as tagging you.",
    ],
    warning:
      "gmail.readonly is a restricted scope. Until your Google app passes OAuth verification, only accounts on its test-users list can connect. That review takes weeks — it's Google's policy, not ours.",
  },
  outlook: {
    consoles: [{ label: "Microsoft Entra admin center", url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps" }],
    steps: [
      "Set up the Microsoft workspace app first — Workspace apps → Microsoft → Set up, above.",
      "Then click Connect here and sign in with the mailbox you want to link.",
      "Approve the requested access.",
    ],
    warning:
      "One Entra app covers both Outlook and Teams, so you only do the workspace setup once.",
  },
  teams: {
    consoles: [{ label: "Microsoft Entra admin center", url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps" }],
    steps: [
      "Set up the Microsoft workspace app first — Workspace apps → Microsoft → Set up, above.",
      "Then click Connect here and sign in.",
      "Approve the requested access. Connecting registers your directory object id as a handle, which is how Teams mentions get matched to you.",
    ],
    warning:
      "One Entra app covers both Outlook and Teams, so you only do the workspace setup once.",
  },
};

/** The guide body. Lifted from WorkspaceApps' SetupDialog so both setup surfaces
 *  read identically. */
export function GuideSteps({ guide }: { guide: ProviderGuide }) {
  return (
    <div className="space-y-2.5">
      <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      {guide.warning && (
        <div className="flex items-start gap-1.5 rounded-xl bg-warning-soft px-2.5 py-2 text-[11px] text-warning">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{guide.warning}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {guide.consoles.map((c) => (
          <a
            key={c.url}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            Open the {c.label}
            <ExternalLink size={12} />
          </a>
        ))}
      </div>
    </div>
  );
}
