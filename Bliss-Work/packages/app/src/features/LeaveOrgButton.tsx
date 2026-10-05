import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@taskboard/ui";
import { ApiError, type OrgMembershipDTO } from "@taskboard/shared";
import { ConfirmDialog } from "./ConfirmDialog";
import { useSwitchOrg } from "./OrgSwitcher";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { signOut } from "../lib/signOut";

/**
 * Leave one of your own organizations, from the row that names it.
 *
 * Confirmed in a dialog rather than on the first click: the membership is
 * marked removed server-side, and getting back in needs an invitation from
 * somebody still inside — not something to do by mis-clicking a row.
 *
 * Only rendered where leaving is actually possible (see Org.tsx). The two
 * server-side refusals — last admin, only organization — are still surfaced
 * verbatim if one is reached anyway; they are written for the reader and say
 * what to do next.
 */
export function LeaveOrgButton({
  org,
  disabled,
  onBusyChange,
}: {
  org: OrgMembershipDTO;
  disabled?: boolean;
  /** Reports this button's own in-flight leave (and, when leaving the active
   *  org, the fallback switch that follows it) up to the parent — Org.tsx
   *  disables its Switch buttons while this is true, so a switch cannot land
   *  mid-leave and clear the query cache out from under it. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation("org");
  const { api, config, ws } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  const user = useSession((s) => s.user);
  const switchOrg = useSwitchOrg();
  const [open, setOpen] = useState(false);
  const [busy, setBusyState] = useState(false);
  const setBusy = (value: boolean) => {
    setBusyState(value);
    onBusyChange?.(value);
  };

  // Already in cache — the page above renders from this very query.
  const { data: orgs = [] } = useQuery({ queryKey: qk.myOrgs, queryFn: () => api.myOrgs() });

  const isActive = org.orgId === user?.orgId;
  const next = orgs.find((o) => o.orgId !== org.orgId);

  const leave = async () => {
    setBusy(true);
    try {
      await api.leaveOrg(org.orgId);
    } catch (err) {
      toast.error(t("org:leaveOrgButton.toasts.failedTitle"), {
        description:
          err instanceof ApiError && err.message ? err.message : t("org:leaveOrgButton.toasts.failedDescriptionFallback"),
      });
      setBusy(false);
      return;
    }
    toast.success(t("org:leaveOrgButton.toasts.left", { orgName: org.orgName }));
    setOpen(false);

    if (!isActive) {
      await qc.invalidateQueries({ queryKey: qk.myOrgs });
      setBusy(false);
      return;
    }
    // Leaving revoked every session that membership held, so this client cannot
    // keep working in the org it just left — the next request would 401.
    // Switching re-mints a session for one we still belong to; the server
    // refuses the leave outright unless another membership remains.
    try {
      if (!next) throw new Error("no remaining organization to switch to");
      await switchOrg(next.orgId);
    } catch {
      // Either nothing was left to adopt, or adopting it failed. Signing out is
      // the only honest end state: the session in hand belongs to a membership
      // that no longer exists, so staying put only defers a bare 401 to
      // whichever screen the user opens next.
      //
      // Goes through the shared signOut() helper — not a hand-rolled
      // clear+persist+broadcast — so this forced logout also closes the
      // activity session and the realtime socket first, exactly like an
      // ordinary sign-out does. It used to skip both, which is the same "I
      // logged out and still show as Online" bug signOut()'s own docstring
      // describes, reintroduced at this second call site.
      await signOut(api, config, ws);
      nav("/login");
      toast.error(t("org:leaveOrgButton.toasts.signedOutTitle"), {
        description: t("org:leaveOrgButton.toasts.signedOutDescription"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger hover:bg-surface-2"
        disabled={disabled || busy}
        onClick={() => setOpen(true)}
      >
        {t("org:leaveOrgButton.leaveButton")}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={t("org:leaveOrgButton.confirmDialog.title", { orgName: org.orgName })}
        message={
          <>
            <Trans
              i18nKey="org:leaveOrgButton.confirmDialog.message"
              values={{ orgName: org.orgName }}
              components={{ bold: <strong className="text-fg" /> }}
            />
            {isActive && next && (
              <Trans
                i18nKey="org:leaveOrgButton.confirmDialog.movedMessage"
                values={{ orgName: next.orgName }}
                components={{ bold: <strong className="text-fg" /> }}
              />
            )}
          </>
        }
        confirmLabel={t("org:leaveOrgButton.confirmDialog.confirmLabel")}
        danger
        busy={busy}
        onConfirm={leave}
      />
    </>
  );
}
