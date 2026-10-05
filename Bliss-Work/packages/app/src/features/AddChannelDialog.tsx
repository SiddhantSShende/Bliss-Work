import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, Compass, Globe, Lock, LogIn, Search } from "lucide-react";
import { Button, EmptyState, Input } from "@taskboard/ui";
import type { ChannelDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useJoinChannel } from "../lib/useJoinChannel";
import { Modal } from "./Modal";
import { CreateChannelPanel } from "./CreateChannelPanel";

/** The backend's own page-size cap (messaging-svc's maxChannelPage) — one
 *  request covers every realistic org, so this popup can offer a single
 *  searchable list instead of the sidebar Browse tab's "Load more" paging. */
const ALL_OPEN_LIMIT = 200;

/**
 * "+" popup: one dialog, two tabs — create a brand-new channel (the default),
 * or search every channel this user is allowed to know about and join one.
 * Switching tabs swaps content in place; it never closes or stacks a second
 * popup.
 *
 * ── Why locked channels you're not in are never listed on the Add tab ───────
 * api.openChannels() deliberately excludes them — see its own doc comment:
 * "Locked channels are never listed here; you only see them via explicit
 * invite" — and joinChannel() 403s a self-join to one regardless. Listing
 * them here anyway (even with Join disabled) would leak a private channel's
 * name and member count to people who aren't in it, which is exactly what
 * that design decision exists to prevent. So "all current channels" here
 * means every channel this user is already allowed to know about: their own
 * (open or locked) plus the org's open directory.
 *
 * ── Reuses, doesn't replace ──────────────────────────────────────────────────
 * routes/ChannelsList.tsx's own "My channels"/"Browse" tabs are untouched —
 * same queries, same join mutation. This is a second, faster entry point onto
 * the same data, not a redesign.
 */
export function AddChannelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("chatList");
  const { api } = useRuntime();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"create" | "browse">("create");

  useEffect(() => {
    if (open) {
      setSearch("");
      setTab("create");
    }
  }, [open]);

  const { data: mine = [], isPending: minePending } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    enabled: open && tab === "browse",
  });
  // A key distinct from qk.openChannels (["channels","open"]) on purpose: the
  // sidebar's own Browse tab reads THAT key through useInfiniteQuery, whose
  // cached shape ({pages, pageParams}) is not the flat array a plain
  // useQuery expects — sharing the key would let whichever hook writes last
  // corrupt the other's cache entry.
  const {
    data: openChannels = [],
    isPending: openPending,
    isError: openFailed,
    refetch: retryOpen,
  } = useQuery({
    queryKey: [...qk.openChannels, "all"],
    queryFn: () => api.openChannels({ limit: ALL_OPEN_LIMIT }),
    enabled: open && tab === "browse",
  });

  const all = useMemo(() => {
    const byId = new Map<string, ChannelDTO>();
    for (const c of mine) byId.set(c.id, c);
    for (const c of openChannels) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [mine, openChannels]);

  const query = search.trim().toLowerCase();
  const filtered = query ? all.filter((c) => c.name.toLowerCase().includes(query)) : all;
  const loading = minePending || openPending;

  // Same mutation, same toasts, same invalidations (qk.channels feeds both
  // "My channels" and the rail badge in routes/AppShell.tsx) as the sidebar's
  // own Browse tab — see lib/useJoinChannel. Invalidating qk.openChannels
  // (["channels","open"]) also covers this dialog's own
  // [...qk.openChannels, "all"] key, since TanStack Query matches by prefix.
  const joinMut = useJoinChannel();

  return (
    <Modal open={open} onClose={onClose} title={t("addChannel.title")}>
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setTab("create")}
            className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
              tab === "create" ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-2"
            }`}
          >
            {t("addChannel.tabs.create")}
          </button>
          <button
            type="button"
            onClick={() => setTab("browse")}
            className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
              tab === "browse" ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-2"
            }`}
          >
            {t("addChannel.tabs.browse")}
          </button>
        </div>

        {tab === "create" ? (
          <CreateChannelPanel onCreated={onClose} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("addChannel.searchPlaceholder")}
                autoFocus
              />
            </div>

            <div className="max-h-80 min-h-32 space-y-0.5 overflow-y-auto">
              {loading ? (
                <div className="py-8 text-center text-sm text-muted">{t("addChannel.loading")}</div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  className="py-8"
                  icon={<Compass size={20} />}
                  title={query ? t("addChannel.emptySearch.title") : t("addChannel.empty.title")}
                  hint={query ? t("addChannel.emptySearch.hint") : t("addChannel.empty.hint")}
                />
              ) : (
                filtered.map((c) => (
                  <AddChannelRow
                    key={c.id}
                    channel={c}
                    onJoin={() => joinMut.mutate(c.id)}
                    joining={joinMut.isPending && joinMut.variables === c.id}
                  />
                ))
              )}
            </div>

            {openFailed && (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                {t("addChannel.loadError")}
                <button type="button" onClick={() => void retryOpen()} className="font-semibold underline">
                  {t("addChannel.retry")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function AddChannelRow({
  channel: c,
  onJoin,
  joining,
}: {
  channel: ChannelDTO;
  onJoin: () => void;
  joining: boolean;
}) {
  const { t } = useTranslation("chatList");
  const Icon = c.isLocked ? Lock : Globe;
  return (
    <div className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{c.name}</span>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
              c.isLocked ? "bg-warning/15 text-warning" : "bg-accent-soft text-accent"
            }`}
          >
            {c.isLocked ? t("addChannel.row.private") : t("addChannel.row.public")}
          </span>
        </div>
        <div className="truncate text-xs text-muted">
          {t("common.memberCount", { count: c.memberCount })}
        </div>
      </div>
      {c.iAmMember ? (
        <span className="flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted">
          <Check size={13} /> {t("addChannel.row.joined")}
        </span>
      ) : (
        <Button size="sm" variant="subtle" onClick={onJoin} loading={joining}>
          <LogIn size={13} /> {t("common.join")}
        </Button>
      )}
    </div>
  );
}
