import { Mic, MicOff } from "lucide-react";
import { cn } from "@taskboard/ui";
import type { ParticipantDemo } from "./types";

export function ParticipantCard({
  participant,
  size = "small",
  active = false,
}: {
  participant: ParticipantDemo;
  size?: "small" | "stage";
  active?: boolean;
}) {
  const initials = participant.name.slice(0, 2).toUpperCase();

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-xl ring-2 transition-colors",
        active ? "ring-accent shadow-[0_0_28px_-6px_var(--color-accent)]" : "ring-transparent",
      )}
    >
      {/* Stands in for the real video track — see mockData.ts. */}
      <div className={cn("h-full w-full", participant.gradient)} />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={cn(
            "flex items-center justify-center rounded-full bg-black/30 font-semibold text-white backdrop-blur-sm",
            size === "stage" ? "h-20 w-20 text-2xl" : "h-9 w-9 text-xs",
          )}
        >
          {initials}
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
        <span className={cn("truncate font-medium text-white", size === "stage" ? "text-sm" : "text-[11px]")}>
          {participant.name}
        </span>
        {participant.micOn ? (
          <Mic size={12} className="shrink-0 text-accent" />
        ) : (
          <MicOff size={12} className="shrink-0 text-danger" />
        )}
      </div>
    </div>
  );
}
