import { clock } from "../lib/chatFormat";

/**
 * A centered system notice — a fact about the conversation rather than
 * something either side said. No bubble, no forward affordance (a notice about
 * a forward is not itself forwardable).
 */
export function SystemPill({
  icon,
  at,
  title,
  children,
}: {
  icon: React.ReactNode;
  at?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="my-2 flex justify-center">
      <span
        title={title}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-[11px] font-medium text-muted ring-1 ring-border/60"
      >
        {icon}
        {children}
        <span className="text-muted/70">{clock(at)}</span>
      </span>
    </div>
  );
}
