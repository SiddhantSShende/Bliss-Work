/**
 * External Integrations page.
 *
 * A shell over five independent sections:
 *   1. Workspace apps       — this org's own Google/Microsoft OAuth apps
 *   2. Connected accounts   — connect/disconnect external platforms
 *   3. Mentions             — messages that tagged you, with Claim / Ignore
 *   4. My handles           — what makes a mention "yours"
 *   5. Forwarding activity  — who forwarded messages you sent
 *
 * The only logic living here is the OAuth return trip, which arrives two ways:
 * as query params on the web (the callback 302s back into the SPA), or through
 * the taskboard:// deep link on desktop, where the consent screen ran in the
 * system browser because Google refuses embedded webviews.
 */
import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { WorkspaceApps } from "../features/WorkspaceApps";
import { ConnectedAccounts } from "../features/ConnectedAccounts";
import { HubMentions } from "../features/HubMentions";
import { MyHandles } from "../features/MyHandles";
import { ForwardingActivity } from "../features/ForwardingActivity";
import { useGoBack } from "../lib/useGoBack";

export function Integrations() {
  const qc = useQueryClient();
  const { config } = useRuntime();
  const goBack = useGoBack();

  // Shared by both return paths: tell the user, then refresh what changed.
  // useCallback keeps it stable so the effects below can depend on it honestly
  // instead of suppressing the exhaustive-deps rule.
  const settle = useCallback(
    (connected?: string | null, error?: string | null) => {
      if (connected) {
        toast.success(`Connected ${connected}`);
        void qc.invalidateQueries({ queryKey: qk.integrations });
        // Connecting auto-derives that account's mention handles.
        void qc.invalidateQueries({ queryKey: qk.providerIdentities });
      } else if (error) {
        toast.error("Couldn't connect", {
          description: error === "oauth_failed" ? "The authorization didn't complete." : error,
        });
      }
    },
    [qc],
  );

  // Web: /app/integrations?connected=… (or ?error=…). Clean the URL after.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    settle(connected, error);
    if (connected || error) window.history.replaceState({}, "", window.location.pathname);
  }, [settle]);

  // Desktop: the callback comes back as a taskboard://oauth deep link.
  useEffect(() => config.onOAuthReturn?.((r) => settle(r.connected, r.error)), [config, settle]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="External Integrations"
        subtitle="Connect other platforms, catch the messages that tag you, and track where your messages travel."
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-2xl space-y-8 pb-8">
          {/* Workspace apps come FIRST: connecting Gmail/Outlook/Teams is
              blocked until this workspace registers its own OAuth app, so
              showing it after "Connect" would explain the 409 too late. */}
          <WorkspaceApps />
          <ConnectedAccounts />
          <HubMentions />
          <MyHandles />
          <ForwardingActivity />
        </div>
      </div>
    </div>
  );
}
