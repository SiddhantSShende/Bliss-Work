import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon } from "lucide-react";
import { EmptyState, PageHeader } from "@taskboard/ui";
import type {
  ChannelDTO,
  ConversationDTO,
  SentTaskDTO,
  StickyTaskDTO,
  UserDTO,
} from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useSession } from "../store/session";
import { matchUser, rankUsers } from "../lib/matchUser";
import { SearchResults, type SearchGroup } from "../features/SearchResults";

const bucket = (s: string) =>
  s === "IGNORED" ? "ignored" : s === "COMPLETED" || s === "LEFT" ? "completed" : "allocated";

export function Search() {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const ql = q.toLowerCase();

  const { data: people = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const { data: channels = [] } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const { data: chats = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  const { data: assigned = [] } = useQuery({ queryKey: qk.assigned, queryFn: () => api.taskAssigned() });
  const { data: sent = [] } = useQuery({ queryKey: qk.sent, queryFn: () => api.tasksSent() });

  const groups = useMemo<SearchGroup[]>(() => {
    if (!q) return [];
    const tasks = new Map<string, { id: string; title: string; subtitle?: string; to: string }>();
    assigned
      .filter((t: StickyTaskDTO) => t.title.toLowerCase().includes(ql) || t.description.toLowerCase().includes(ql))
      .forEach((t) =>
        tasks.set(t.taskId, { id: t.taskId, title: t.title, subtitle: t.description || undefined, to: `/app/tasks/${bucket(t.myStatus)}` }),
      );
    sent
      .filter((t: SentTaskDTO) => t.title.toLowerCase().includes(ql) || t.description.toLowerCase().includes(ql))
      .forEach((t) => {
        if (!tasks.has(t.taskId))
          tasks.set(t.taskId, { id: t.taskId, title: t.title, subtitle: t.description || undefined, to: "/app/tasks/mine" });
      });

    const all: SearchGroup[] = [
      {
        key: "people",
        label: "People",
        rows: rankUsers(people.filter((u: UserDTO) => u.id !== me.id && matchUser(u, q)), q).map((u) => ({
          id: u.id,
          title: u.displayName,
          subtitle: `@${u.username}`,
          to: "/app/chats",
        })),
      },
      {
        key: "channels",
        label: "Channels",
        rows: channels
          .filter((c: ChannelDTO) => c.name.toLowerCase().includes(ql))
          .map((c) => ({ id: c.id, title: c.name, subtitle: `${c.memberCount} members`, to: `/app/channels/${c.id}` })),
      },
      {
        key: "chats",
        label: "Chats",
        rows: chats
          .filter((c: ConversationDTO) => c.peerUsername.toLowerCase().includes(ql) || (c.lastMessage ?? "").toLowerCase().includes(ql))
          .map((c) => ({ id: c.id, title: c.peerUsername, subtitle: c.lastMessage ?? undefined, to: `/app/chats/${c.id}` })),
      },
      { key: "tasks", label: "Tasks", rows: [...tasks.values()] },
    ];
    return all.filter((g) => g.rows.length > 0);
  }, [q, ql, people, channels, chats, assigned, sent, me.id]);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Search" subtitle={q ? `Results for “${q}”` : undefined} />
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {!q ? (
          <EmptyState icon={<SearchIcon size={24} />} title="Search BlissWork" hint="Find people, channels, chats, and tasks." />
        ) : total === 0 ? (
          <EmptyState icon={<SearchIcon size={24} />} title="No matches" hint={`Nothing matched “${q}”.`} />
        ) : (
          <SearchResults groups={groups} />
        )}
      </div>
    </div>
  );
}
