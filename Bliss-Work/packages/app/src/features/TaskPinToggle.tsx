import { useRef, useState } from "react";
import { Pin } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ApiError } from "@taskboard/shared";
import { isUnpinned, useSetStickyPin, useStickyPinStates } from "../lib/stickyPinState";

/**
 * The card's Pin / Unpin control. It drives the user's SHARED pin state in
 * sticky-svc (ApiClient.stickyPin / stickyUnpin) — the same state the browser
 * stickies and the desktop notes follow — and renders from that state's React
 * Query copy (`qk.stickyPinStates`), which the realtime `sticky.pin.changed`
 * event keeps current. Nothing is kept locally: no per-device marker, no
 * component-owned pin flag.
 *
 * Pinned shows a FILLED pin and offers "Unpin task"; unpinned shows an outline
 * pin and offers "Pin task". It is only ever a pin control — never Ignore or
 * Leave, which live in the card's button row — and an unpin is always
 * reversible.
 *
 * A fixed 24px square in every state — the footprint of the header X it replaces
 * — so toggling (or the disabled in-flight look) never moves the header.
 */
export function TaskPinToggle({ taskId }: { taskId: string }) {
  const { t } = useTranslation("tasks");
  const { data: pinStates } = useStickyPinStates(true);
  const setPin = useSetStickyPin();
  // A ref beside the state: two clicks inside one render would both see
  // `pending === false`, and the second request would race the first.
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  // No recorded choice (or an unavailable read) means pinned: that is the
  // default every assignment starts in.
  const pinned = !isUnpinned(pinStates, taskId);
  const label = pinned ? t("tasksPage.unpinTask") : t("tasksPage.pinTask");

  const toggle = (e: React.MouseEvent) => {
    // The control sits inside a card; whatever the card does on click must not
    // fire from here.
    e.stopPropagation();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setPin(taskId, !pinned)
      .catch((err) => {
        toast.error(err instanceof ApiError ? err.message : pinned ? t("tasksPage.unpinFailed") : t("tasksPage.pinFailed"));
      })
      .finally(() => {
        inFlight.current = false;
        setPending(false);
      });
  };

  return (
    <button
      type="button"
      className={`app-no-drag inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        pinned ? "bg-accent-soft text-accent hover:bg-accent-soft/70" : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
      title={label}
      aria-label={label}
      aria-pressed={pinned}
      disabled={pending}
      onClick={toggle}
    >
      <Pin size={16} fill={pinned ? "currentColor" : "none"} />
    </button>
  );
}
