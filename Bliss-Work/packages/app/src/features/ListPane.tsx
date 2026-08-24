import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

/** Shared building blocks for the WhatsApp-style middle list pane. */
export function ListHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          title="Back"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="-ml-2 rounded-lg p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <ChevronLeft size={18} />
        </button>
        <h2 className="text-base font-semibold tracking-tight text-fg">{title}</h2>
      </div>
      {action}
    </div>
  );
}

export const rowClass = (active: boolean) =>
  `flex items-center gap-3 rounded-xl p-2.5 text-left transition-colors ${
    active ? "bg-gradient-to-r from-accent/20 to-accent/5 ring-1 ring-accent/15" : "hover:bg-surface-2"
  }`;

export function relTime(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "short" });
}
