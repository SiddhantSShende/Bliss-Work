/**
 * Forwarding activity — "who forwarded my messages".
 *
 * When someone forwards a message you sent, it shows up here (and you get a
 * live toast), expandable into the full downstream forward tree.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Forward, Loader2 } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import type { ForwardActivityDTO, ForwardEdgeDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

export function ForwardingActivity() {
  const { api } = useRuntime();
  const { data: activity = [], isLoading } = useQuery({
    queryKey: qk.forwardActivityFeed,
    queryFn: () => api.myForwardActivity(),
  });

  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
        <Forward size={16} className="text-accent" /> Forwarding activity
      </h2>
      <p className="mb-3 text-xs text-muted">
        When someone forwards a message you sent, it appears here — with who forwarded it, to whom,
        on which platform, and when.
      </p>
      {isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : activity.length === 0 ? (
        <div className="glass rounded-2xl p-6">
          <EmptyState
            icon={<Forward size={22} />}
            title="No forwards yet"
            hint="Forward a message from any chat, and its journey shows up here."
          />
        </div>
      ) : (
        <div className="space-y-2">
          {activity.map((a) => (
            <ForwardActivityRow key={a.rootMessageId} item={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function ForwardActivityRow({ item }: { item: ForwardActivityDTO }) {
  const { api } = useRuntime();
  const [open, setOpen] = useState(false);

  const { data: dir = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const nameOf = (id?: string | null) =>
    (dir as UserDTO[]).find((u) => u.id === id)?.displayName ?? "someone";

  const { data: edges = [], isLoading } = useQuery({
    queryKey: qk.forwardActivity(item.rootMessageId),
    queryFn: () => api.messageForwards(item.rootMessageId),
    enabled: open,
  });

  return (
    <div className="glass rounded-2xl">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        {open ? (
          <ChevronDown size={16} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={16} className="shrink-0 text-muted" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">“{item.preview}”</div>
          <div className="mt-0.5 text-xs text-muted">
            forwarded {item.forwardCount} {item.forwardCount === 1 ? "time" : "times"} · last{" "}
            {new Date(item.lastForwardedAt).toLocaleString()}
            {item.hasUnconfirmed && (
              <span className="ml-1.5 text-amber-500">· some unconfirmed</span>
            )}
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-border/60 p-4 pt-3">
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={12} className="animate-spin" /> Loading forward tree…
            </div>
          ) : edges.length === 0 ? (
            <div className="text-xs text-muted">No forwards recorded.</div>
          ) : (
            <ul className="space-y-1.5 overflow-x-auto">
              {edges.map((e: ForwardEdgeDTO) => {
                const to = e.forwardedTo
                  ? nameOf(e.forwardedTo)
                  : (e.forwardedToName ?? e.forwardedToExternal ?? "someone");
                const via = e.platform === "blisswork" ? "" : ` · via ${e.platform}`;
                // An opened deep link is not a delivery. Rendering it the same
                // way as a provider-acknowledged send would make this feed —
                // whose whole promise is telling the author where their message
                // went — assert something nobody observed.
                const unconfirmed = e.delivery === "unconfirmed";
                return (
                  <li
                    key={e.id}
                    className="flex items-center gap-2 text-xs text-fg"
                    style={{ paddingLeft: `${(e.depth - 1) * 16}px` }}
                  >
                    <Forward size={12} className="shrink-0 text-accent" />
                    <span>
                      <span className="font-medium">{nameOf(e.forwardedBy)}</span>{" "}
                      {unconfirmed ? "opened WhatsApp to forward to" : "forwarded to"}{" "}
                      <span className="font-medium">{to}</span>
                      {unconfirmed && (
                        <span
                          className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
                          title="BlissWork opened WhatsApp with the message prefilled. Whether it was sent isn't something we can observe."
                        >
                          Unconfirmed
                        </span>
                      )}
                      <span className="text-muted">
                        {via} · {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
