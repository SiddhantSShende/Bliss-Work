import { NavLink } from "react-router-dom";
import { Hash, ListTodo } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import { rowClass } from "./ListPane";

export interface SearchRow {
  id: string;
  title: string;
  subtitle?: string;
  to: string;
  /**
   * Open this hit by doing something rather than by following `to`.
   *
   * For results whose destination is not addressable. A chat is the one such
   * result: which conversation is open is held in memory precisely so its id
   * stays out of the URL (lib/selectedChat), so there is no per-chat path for a
   * link to point at. `to` is still required and still used as the fallback —
   * every other group is a real route.
   */
  onSelect?: () => void;
}

export interface SearchGroup {
  key: "people" | "channels" | "chats" | "tasks";
  label: string;
  rows: SearchRow[];
}

/** Renders grouped search hits; each row links to its detail view. */
export function SearchResults({ groups }: { groups: SearchGroup[] }) {
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.key}>
          <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {g.label} · {g.rows.length}
          </h2>
          <div className="space-y-0.5">
            {g.rows.map((r) => {
              const body = (
                <>
                  <Leading kind={g.key} title={r.title} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-fg">{r.title}</div>
                    {r.subtitle && <div className="truncate text-sm text-muted">{r.subtitle}</div>}
                  </div>
                </>
              );
              return r.onSelect ? (
                <button
                  key={r.id}
                  type="button"
                  onClick={r.onSelect}
                  className={`${rowClass(false)} w-full`}
                >
                  {body}
                </button>
              ) : (
                <NavLink key={r.id} to={r.to} className={rowClass(false)}>
                  {body}
                </NavLink>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function Leading({ kind, title }: { kind: SearchGroup["key"]; title: string }) {
  if (kind === "people" || kind === "chats") return <Avatar name={title} />;
  const Icon = kind === "channels" ? Hash : ListTodo;
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
      <Icon size={17} />
    </span>
  );
}
