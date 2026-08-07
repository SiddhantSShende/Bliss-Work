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
  /** Where the user goes to get these values. */
  consoleLabel: string;
  consoleUrl: string;
  /** One action per step, imperative, in the order they happen. */
  steps: string[];
  /** The thing that bites people. Rendered in the warning callout. */
  warning?: string;
}

export const GUIDES: Record<string, ProviderGuide> = {
  slack: {
    consoleLabel: "Slack API dashboard",
    consoleUrl: "https://api.slack.com/apps",
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
  whatsapp: {
    consoleLabel: "Meta for Developers",
    consoleUrl: "https://developers.facebook.com/apps",
    steps: [
      "WhatsApp Business accounts only — you need a WhatsApp Business Account with a number Meta has verified. A personal WhatsApp account can't be connected.",
      "Create an app at Meta for Developers and add the WhatsApp product to it.",
      "WhatsApp → API Setup → copy the WhatsApp Business Account ID and, below it, the Phone number ID of your business number.",
      "Create a System User token with BOTH whatsapp_business_messaging (to send) and whatsapp_business_management (so we can check the account), and copy it.",
      "App Settings → Basic → copy the App Secret.",
      "Click Connect and paste all four. We check with Meta that the number is verified and belongs to your Business Account before saving anything.",
      "The connection then shows a webhook URL and a verify token. In Meta: WhatsApp → Configuration → Webhook → Edit, paste both, and subscribe to the messages field.",
      "Saving that is the last step — Meta calls us straight away, and the connection turns Connected on its own.",
    ],
    warning:
      "Meta has to agree it's a business before we'll connect it. We reject the account if it isn't approved by Meta, if the number hasn't finished verification, if it's an on-premise rather than Cloud API number, or if the number doesn't belong to the Business Account ID you entered. If your token is missing whatsapp_business_management we'll say so explicitly — that one catches almost everybody first time.",
  },
  gmail: {
    consoleLabel: "Google Cloud Console",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "Set up the Google workspace app first — Workspace apps → Google → Set up, above.",
      "Then click Connect here and sign in with the mailbox you want to link.",
      "Approve the requested access. Mail addressed to that mailbox starts counting as tagging you.",
    ],
    warning:
      "gmail.readonly is a restricted scope. Until your Google app passes OAuth verification, only accounts on its test-users list can connect. That review takes weeks — it's Google's policy, not ours.",
  },
  outlook: {
    consoleLabel: "Microsoft Entra admin center",
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps",
    steps: [
      "Set up the Microsoft workspace app first — Workspace apps → Microsoft → Set up, above.",
      "Then click Connect here and sign in with the mailbox you want to link.",
      "Approve the requested access.",
    ],
    warning:
      "One Entra app covers both Outlook and Teams, so you only do the workspace setup once.",
  },
  teams: {
    consoleLabel: "Microsoft Entra admin center",
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps",
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

      <a
        href={guide.consoleUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
      >
        Open the {guide.consoleLabel}
        <ExternalLink size={12} />
      </a>
    </div>
  );
}
