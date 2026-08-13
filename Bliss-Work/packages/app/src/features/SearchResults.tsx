import { NavLink } from "react-router-dom";
import { Hash, ListTodo } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import { rowClass } from "./ListPane";

export interface SearchRow {
  id: string;
  title: string;
  subtitle?: string;
  to: string;
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
            {g.rows.map((r) => (
              <NavLink key={r.id} to={r.to} className={rowClass(false)}>
                <Leading kind={g.key} title={r.title} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-fg">{r.title}</div>
                  {r.subtitle && <div className="truncate text-sm text-muted">{r.subtitle}</div>}
                </div>
              </NavLink>
            ))}
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
