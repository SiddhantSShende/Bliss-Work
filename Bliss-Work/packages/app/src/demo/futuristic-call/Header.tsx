export function Header({
  title = "PROJECT AURORA - SYNC CALL",
  time = "11:30 AM IST",
  participantCount,
}: {
  title?: string;
  time?: string;
  participantCount: number;
}) {
  return (
    <header className="min-w-0">
      <div className="truncate text-base font-semibold uppercase tracking-wide text-fg">
        {title} <span className="text-muted">| {time}</span>
      </div>
      <div className="mt-1 text-xs text-muted">
        {participantCount} Participant{participantCount === 1 ? "" : "s"} Present
      </div>
    </header>
  );
}
