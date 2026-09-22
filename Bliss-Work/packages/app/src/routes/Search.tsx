import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import { displayNameOf } from "../lib/userLabel";
import { SearchResults, type SearchGroup } from "../features/SearchResults";
import { useGoBack } from "../lib/useGoBack";
import { CHATS_PATH, useSelectedChat } from "../lib/selectedChat";

const bucket = (s: string) =>
  s === "IGNORED" ? "ignored" : s === "COMPLETED" || s === "LEFT" ? "completed" : "allocated";

export function Search() {
  const { t } = useTranslation("shell");
  const { api } = useRuntime();
  const goBack = useGoBack();
  const me = useSession((s) => s.user)!;
  const { openChat } = useSelectedChat();
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
        label: t("search.groups.people"),
        rows: rankUsers(people.filter((u: UserDTO) => u.id !== me.id && matchUser(u, q)), q).map((u) => ({
          id: u.id,
          title: u.displayName,
          subtitle: `@${u.username}`,
          avatarUrl: u.avatarUrl,
          to: `/app/members/${u.id}`,
        })),
      },
      {
        key: "channels",
        label: t("search.groups.channels"),
        rows: channels
          .filter((c: ChannelDTO) => c.name.toLowerCase().includes(ql))
          .map((c) => ({
            id: c.id,
            title: c.name,
            subtitle: t("search.channelMembers", { count: c.memberCount }),
            to: `/app/channels/${c.id}`,
          })),
      },
      {
        key: "chats",
        label: t("search.groups.chats"),
        // Labelled by the peer's NAME. `peerUsername` is the email local-part
        // (see lib/userLabel), so titling a chat result with it put an address
        // fragment where every other chat surface shows a person.
        //
        // The name is MATCHED as well as shown — searching a colleague's actual
        // name used to miss their chat entirely — while the handle stays
        // matchable, so nothing that used to be findable stopped being findable.
        rows: chats
          .filter((c: ConversationDTO) =>
            displayNameOf(c).toLowerCase().includes(ql) ||
            c.peerUsername.toLowerCase().includes(ql) ||
            (c.lastMessage ?? "").toLowerCase().includes(ql))
          // Opened by selecting rather than by navigating: a conversation has
          // no URL of its own (lib/selectedChat), so `to` is the section and
          // onSelect is what actually opens the chat.
          .map((c) => ({
            id: c.id,
            title: displayNameOf(c),
            subtitle: c.lastMessage ?? undefined,
            to: CHATS_PATH,
            onSelect: () => openChat(c.id),
          })),
      },
      { key: "tasks", label: t("search.groups.tasks"), rows: [...tasks.values()] },
    ];
    return all.filter((g) => g.rows.length > 0);
    // openChat is stable (a useCallback over `navigate`), so listing it costs
    // nothing — but leaving it out would be a stale closure the day it stops
    // being stable.
  }, [q, ql, people, channels, chats, assigned, sent, me.id, openChat, t]);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("search.title")}
        subtitle={q ? t("search.resultsFor", { query: q }) : undefined}
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {!q ? (
          <EmptyState
            icon={<SearchIcon size={24} />}
            title={t("search.empty.title", { brand: "BlissWork" })}
            hint={t("search.empty.hint")}
          />
        ) : total === 0 ? (
          <EmptyState
            icon={<SearchIcon size={24} />}
            title={t("search.noResults.title")}
            hint={t("search.noResults.hint", { query: q })}
          />
        ) : (
          <SearchResults groups={groups} />
        )}
      </div>
    </div>
  );
}
