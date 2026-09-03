import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, ChevronLeft, Download } from "lucide-react";
import {
  BarChart,
  Button,
  EmptyState,
  PageHeader,
  RankedBars,
  Spinner,
  StatTile,
  formatMs,
} from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { Tabs } from "../features/Tabs";
import { ExportActivityDialog } from "../features/ExportActivityDialog";
import { ACTIVITY_RANGES, computeRange, parseLocalDay, type RangeKey } from "../lib/dateRange";

/** Workspace-wide activity: the whole team's shape, and a table of who did what. */
export function OrgActivity() {
  const { api } = useRuntime();
  const nav = useNavigate();
  const me = useSession((s) => s.user)!;
  const isAdmin = me.roles.includes("org_admin");
  const [range, setRange] = useState<RangeKey>("30d");
  const [exportOpen, setExportOpen] = useState(false);
  const { from, to } = computeRange(range);

  const { data: directory = [] } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(true),
    enabled: isAdmin,
  });
  const { data, isLoading } = useQuery({
    queryKey: qk.orgActivitySummary(from, to),
    queryFn: () => api.orgActivitySummary({ from, to }),
    enabled: isAdmin,
  });

  if (!isAdmin)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<BarChart3 size={24} />}
          title="Admins only"
          hint="Your own activity is under Settings → Your activity."
        />
      </div>
    );

  const nameOf = (id: string) => directory.find((u) => u.id === id)?.displayName ?? id;
  const members = [...(data?.members ?? [])].sort((a, b) => b.totalActiveMs - a.totalActiveMs);
  const totalActive = members.reduce((n, m) => n + m.totalActiveMs, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <button
            onClick={() => nav("/app/members")}
            className="mb-2 inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <ChevronLeft size={16} /> Members
          </button>
          <PageHeader title="Workspace activity" subtitle="How the team's time is spent." />
        </div>
        <Button variant="ghost" size="sm" onClick={() => setExportOpen(true)}>
          <Download size={15} /> Export
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-5">
        <Tabs tabs={ACTIVITY_RANGES} active={range} onChange={setRange} />

        {isLoading ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : members.length === 0 ? (
          <EmptyState
            icon={<BarChart3 size={22} />}
            title="No activity in this period"
            hint="Charts appear once the team has been using BlissWork for a day."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Team active time"
                value={formatMs(totalActive)}
                trend={(data?.days ?? []).map((d) => d.activeMs)}
              />
              <StatTile label="People active" value={String(members.length)} />
              <StatTile
                label="Per person"
                value={formatMs(members.length ? totalActive / members.length : 0)}
                hint="average over the range"
              />
              <StatTile
                label="Sessions"
                value={String(members.reduce((n, m) => n + m.sessions, 0))}
              />
            </div>

            <section className="space-y-3">
              <h4 className="text-sm font-semibold text-fg">Team active time per day</h4>
              <BarChart
                data={(data?.days ?? []).map((d) => ({
                  label: parseLocalDay(d.day).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
                  value: d.activeMs,
                  context: d.idleMs,
                }))}
                valueLabel="Active"
                contextLabel="Idle"
              />
            </section>

            <section className="space-y-3">
              <h4 className="text-sm font-semibold text-fg">Active time by member</h4>
              <RankedBars
                data={members.map((m) => ({
                  key: m.userId, label: nameOf(m.userId), value: m.totalActiveMs,
                }))}
                max={members.length}
              />
            </section>

            {/* A real table, deliberately — this grid is a lookup ("what did
                Priya do"), not a shape to read, and a table is what a screen
                reader and a keyboard can navigate. It is the only <table> in the
                app, and this is the case that earns one. */}
            <section className="space-y-3">
              <h4 className="text-sm font-semibold text-fg">All members</h4>
              <div className="overflow-x-auto rounded-xl border border-border/60">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left text-xs text-muted">
                      <Th>Member</Th><Th right>Active</Th><Th right>Idle</Th>
                      <Th right>Sessions</Th><Th right>Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr
                        key={m.userId}
                        className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-surface-2"
                        onClick={() => nav(`/app/members/${m.userId}`)}
                      >
                        <td className="px-3 py-2 text-fg">{nameOf(m.userId)}</td>
                        <Td>{formatMs(m.totalActiveMs)}</Td>
                        <Td>{formatMs(m.totalIdleMs)}</Td>
                        <Td>{m.sessions}</Td>
                        <Td>{m.events}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>

      <ExportActivityDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 text-right tabular-nums text-muted">{children}</td>;
}
