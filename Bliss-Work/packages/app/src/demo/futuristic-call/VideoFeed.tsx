import { cn } from "@taskboard/ui";
import { BracketFrame } from "../../features/BracketFrame";
import { ParticipantCard } from "./ParticipantCard";
import type { ParticipantDemo } from "./types";

/** The two shapes the main content area supports — Layout A and Layout B
 *  from the spec. Screen share gets a wide bracket-framed capture with a
 *  filmstrip of 4 below it; a speaking participant gets the bracket-framed
 *  stage with a column of 3 beside it — same split the real CallRoom uses. */
export function VideoFeed({
  layout,
  stageParticipant,
  otherParticipants,
}: {
  layout: "speaker" | "screenshare";
  stageParticipant: ParticipantDemo;
  otherParticipants: ParticipantDemo[];
}) {
  const screenshare = layout === "screenshare";
  const shown = otherParticipants.slice(0, screenshare ? 4 : 3);

  return (
    <div className={cn("flex min-h-0 flex-1 gap-3", screenshare ? "flex-col" : "flex-row")}>
      <BracketFrame className="glass relative min-h-0 flex-1">
        {screenshare ? <ScreenSharePlaceholder /> : <ParticipantCard participant={stageParticipant} size="stage" active />}
      </BracketFrame>

      <div
        className={cn("flex shrink-0 gap-2", screenshare ? "h-24 overflow-x-auto" : "h-full w-32 flex-col overflow-y-auto")}
        aria-label="Other participants"
      >
        {shown.map((p) => (
          <div key={p.id} className={cn("shrink-0", screenshare ? "h-full w-28" : "aspect-video w-full")}>
            <ParticipantCard participant={p} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Placeholder shared-screen content — a fake dashboard, just enough
 *  structure to read as a screen share rather than an empty box. */
function ScreenSharePlaceholder() {
  return (
    <div className="flex h-full w-full flex-col gap-4 bg-[#0b0f24] p-6">
      <div className="flex items-center justify-between">
        <div className="h-3 w-40 rounded-full bg-white/10" />
        <div className="h-3 w-20 rounded-full bg-white/10" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {["Revenue", "Active Users", "Uptime"].map((label) => (
          <div key={label} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="text-[11px] text-white/40">{label}</div>
            <div className="mt-2 text-xl font-semibold text-white">—</div>
          </div>
        ))}
      </div>
      <div className="flex flex-1 items-end gap-2 rounded-xl border border-white/10 bg-white/5 p-4">
        {[40, 65, 30, 80, 55, 90, 45].map((h, i) => (
          <div key={i} className="flex-1 rounded-t bg-accent/60" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}
