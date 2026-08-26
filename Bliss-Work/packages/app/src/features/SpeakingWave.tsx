/**
 * A tiny animated audio-wave — three bars pulsing out of phase — for
 * anywhere a live "talking right now" signal needs to read at a glance,
 * alongside (never instead of) a text label, a ring, or a row highlight.
 */
import { cn } from "@taskboard/ui";

export function SpeakingWave({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-2.5 shrink-0 items-end gap-[2px]", className)} aria-hidden>
      <span className="h-full w-[3px] origin-bottom animate-[bw-wave_0.9s_ease-in-out_infinite] rounded-full bg-current [animation-delay:-0.6s]" />
      <span className="h-full w-[3px] origin-bottom animate-[bw-wave_0.9s_ease-in-out_infinite] rounded-full bg-current [animation-delay:-0.3s]" />
      <span className="h-full w-[3px] origin-bottom animate-[bw-wave_0.9s_ease-in-out_infinite] rounded-full bg-current" />
    </span>
  );
}
