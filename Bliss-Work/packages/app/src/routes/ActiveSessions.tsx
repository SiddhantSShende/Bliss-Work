import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { Button, EmptyState, PageHeader, Spinner } from "@taskboard/ui";
import { ApiError, decodeJwtPayload, type ActiveSessionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { useGoBack } from "../lib/useGoBack";
import { qk } from "../lib/queryBridge";
import { signOut } from "../lib/signOut";
import { ActiveSessionsList } from "../features/ActiveSessionsList";
import { ConfirmDialog } from "../features/ConfirmDialog";

/**
 * Settings > Active sessions — every device/browser currently signed in to
 * this org, with the ability to sign one out remotely.
 *
 * "Which row is THIS device" is decided entirely client-side, by decoding
 * the `sid` claim out of the access token already sitting in memory (see
 * `decodeJwtPayload` — no signature verification, this is informational
 * only, same trust class as auth-svc's `memberships` claim). A server-side
 * check (the refresh cookie) only ever worked on web; desktop/mobile don't
 * reliably send it, and every platform already holds its own access token,
 * so this is both simpler and correct everywhere at once.
 */
export function ActiveSessions() {
  const { t } = useTranslation("account");
  const { api, config, ws } = useRuntime();
  const accessToken = useSession((s) => s.accessToken);
  const qc = useQueryClient();
  const nav = useNavigate();
  const goBack = useGoBack();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ActiveSessionDTO | null>(null);
  const [confirmAllOthers, setConfirmAllOthers] = useState(false);

  const currentSessionId = useMemo(
    () => decodeJwtPayload<{ sid?: string }>(accessToken)?.sid ?? null,
    [accessToken],
  );

  const { data: sessions, isLoading } = useQuery({
    queryKey: qk.activeSessions,
    queryFn: () => api.listSessions(),
  });

  const revokeOne = async (session: ActiveSessionDTO) => {
    if (session.id === currentSessionId) {
      // Ends up calling /auth/logout, not /auth/sessions/{id} — see this
      // component's own doc comment for why that's deliberate here.
      await signOut(api, config, ws);
      nav("/login");
      return;
    }
    setRevokingId(session.id);
    try {
      await api.revokeSession(session.id);
      qc.setQueryData<ActiveSessionDTO[]>(qk.activeSessions, (prev) =>
        (prev ?? []).filter((s) => s.id !== session.id),
      );
      toast.success(t("account:activeSessions.toasts.signedOutOf", { device: session.device }));
    } catch (err) {
      // A 404 here means the session was already gone (revoked elsewhere, or
      // it expired) between the list rendering and this click — refresh the
      // list rather than reporting a failure for something that already
      // succeeded from the user's point of view.
      if (err instanceof ApiError && err.status === 404) {
        await qc.invalidateQueries({ queryKey: qk.activeSessions });
      } else {
        toast.error(t("account:activeSessions.toasts.revokeFailed.title"), {
          description: t("account:activeSessions.toasts.revokeFailed.description"),
        });
      }
    } finally {
      setRevokingId(null);
    }
  };

  const revokeAllOthers = async () => {
    setConfirmAllOthers(false);
    try {
      const revokedIds = await api.revokeOtherSessions(currentSessionId ?? undefined);
      qc.setQueryData<ActiveSessionDTO[]>(qk.activeSessions, (prev) =>
        (prev ?? []).filter((s) => !revokedIds.includes(s.id)),
      );
      toast.success(
        revokedIds.length === 0
          ? t("account:activeSessions.toasts.noOtherSessions")
          : t("account:activeSessions.toasts.signedOutOfOthers", { count: revokedIds.length }),
      );
    } catch {
      toast.error(t("account:activeSessions.toasts.revokeOthersFailed.title"), {
        description: t("account:activeSessions.toasts.revokeOthersFailed.description"),
      });
      await qc.invalidateQueries({ queryKey: qk.activeSessions });
    }
  };

  const others = (sessions ?? []).filter((s) => s.id !== currentSessionId);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("account:activeSessions.header.title")}
        subtitle={t("account:activeSessions.header.subtitle")}
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-4">
          {isLoading ? (
            <div className="flex justify-center p-8">
              <Spinner />
            </div>
          ) : !sessions || sessions.length === 0 ? (
            <EmptyState
              icon={<MonitorSmartphone size={22} />}
              title={t("account:activeSessions.empty.title")}
              hint={t("account:activeSessions.empty.hint")}
            />
          ) : (
            <>
              <div className="glass rounded-2xl p-2">
                <ActiveSessionsList
                  sessions={sessions}
                  revokingId={revokingId}
                  currentSessionId={currentSessionId}
                  onRevoke={(s) => (s.id === currentSessionId ? revokeOne(s) : setConfirmTarget(s))}
                />
              </div>
              {others.length > 0 && (
                <div className="flex justify-end">
                  <Button variant="subtle" size="sm" onClick={() => setConfirmAllOthers(true)}>
                    {t("account:activeSessions.signOutAllOthers")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmTarget !== null}
        onClose={() => !revokingId && setConfirmTarget(null)}
        title={t("account:activeSessions.confirmOne.title")}
        message={
          <Trans
            i18nKey="account:activeSessions.confirmOne.message"
            values={{ device: confirmTarget?.device }}
            components={{ bold: <strong className="text-fg" /> }}
          />
        }
        confirmLabel={t("account:activeSessions.confirmOne.confirmLabel")}
        danger
        busy={revokingId === confirmTarget?.id}
        onConfirm={async () => {
          if (!confirmTarget) return;
          const target = confirmTarget;
          await revokeOne(target);
          setConfirmTarget(null);
        }}
      />

      <ConfirmDialog
        open={confirmAllOthers}
        onClose={() => setConfirmAllOthers(false)}
        title={t("account:activeSessions.confirmAllOthers.title")}
        message={t("account:activeSessions.confirmAllOthers.message", { count: others.length })}
        confirmLabel={t("account:activeSessions.confirmAllOthers.confirmLabel")}
        danger
        onConfirm={revokeAllOthers}
      />
    </div>
  );
}
