import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, UserPlus, Bell } from "lucide-react";
import { Button, IconButton, Wordmark } from "@taskboard/ui";
import { ProfileMenu } from "./ProfileMenu";

/** Global top navbar: brand · search · invite · notifications · account. */
export function TopNavbar({ unread, onOpenNotifs }: { unread: number; onOpenNotifs: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) nav(`/app/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <header className="glass relative z-50 m-2 mb-0 flex h-14 shrink-0 items-center gap-3 rounded-2xl px-3">
      <button
        onClick={() => nav("/app/chats")}
        title="BlissWork"
        className="shrink-0 rounded-xl px-1 transition hover:opacity-80"
      >
        <Wordmark size={26} />
      </button>

      <form onSubmit={submit} className="flex flex-1 justify-center px-2">
        <div className="relative w-full max-w-md">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people, channels, chats, tasks…"
            className="h-9 w-full rounded-xl border border-border bg-surface/70 pl-9 pr-3 text-sm text-fg placeholder:text-muted/70 transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
          />
        </div>
      </form>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="subtle"
          size="sm"
          onClick={() => nav("/app/invite")}
          className="hidden sm:inline-flex"
        >
          <UserPlus size={15} /> Invite
        </Button>
        <div className="relative">
          <IconButton onClick={onOpenNotifs} title="Notifications">
            <Bell size={18} />
          </IconButton>
          {unread > 0 && (
            <span className="pointer-events-none absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold text-white">
              {unread}
            </span>
          )}
        </div>
        <ProfileMenu />
      </div>
    </header>
  );
}
