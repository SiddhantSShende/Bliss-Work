import { useNavigate } from "react-router-dom";
import { ChevronLeft, Eye } from "lucide-react";
import { PageHeader } from "@taskboard/ui";
import { ConnectedAgents } from "../features/ConnectedAgents";
import { MemberTimeline } from "../features/member/MemberTimeline";

/**
 * A member's own activity record.
 *
 * The transparency half of the bargain: everything an admin can see about you,
 * you can see about yourself, rendered by the exact same component reading the
 * exact same endpoint. Passing the literal "me" means the server resolves the
 * subject from the caller's token — there is no way for this page to ask for
 * anyone else, and no second code path that could drift from the admin view.
 */
export function MyActivity() {
  const nav = useNavigate();

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-auto p-5">
      <div>
        <button
          onClick={() => nav("/app/settings")}
          className="mb-3 inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <ChevronLeft size={16} /> Settings
        </button>
        <PageHeader title="Your activity" subtitle="Everything BlissWork records about how you work." />
      </div>

      <section className="space-y-2 rounded-xl border border-border/60 p-4 text-sm text-muted">
        <h3 className="flex items-center gap-2 font-semibold text-fg">
          <Eye size={15} /> What's recorded, and who can see it
        </h3>
        <ul className="list-disc space-y-1 pl-5 leading-relaxed">
          <li>When you sign in and out, and when you're online, idle or offline.</li>
          <li>Which parts of BlissWork you use, and for how long.</li>
          <li>
            Messages you send and tasks you act on — the first line of a message, never the
            whole conversation.
          </li>
          <li>The browser and device you sign in from, and a rough location from your IP.</li>
        </ul>
        <p className="leading-relaxed">
          Your workspace admins can see this record. Detailed activity is kept for 90 days;
          daily totals are kept longer so long-range reports still work.
        </p>
      </section>

      <ConnectedAgents />

      <MemberTimeline userId="me" />
    </div>
  );
}
