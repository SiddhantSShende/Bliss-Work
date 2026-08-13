import { useEffect, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { useRuntime } from "../lib/runtime";

/**
 * 📌 Pin-to-desktop toggle for a chat thread header. Only renders when the
 * Electron sticky-chat bridge is present — on the web app the persistent
 * desktop window doesn't exist, so we hide instead of showing a button that
 * can't deliver.
 *
 * The host arrives via PlatformConfig.chatSticky. It used to be sniffed off
 * `window.chatSticky`, which made it the one platform capability living outside
 * the PlatformConfig seam: its interface was declared here AND in the desktop
 * preload, with nothing checking that the two agreed. Routing it through the
 * config means a mismatch is a compile error and every capability is discovered
 * in one place.
 *
 * State source of truth: main-process sticky-state.json. Renderer hydrates
 * once at mount via `list()` and re-checks on every toggle. No Zustand/
 * TanStack mirror — two sources of truth was the bug Phase 8 was warned about.
 */
export function PinButton(props: {
  threadId: string;
  conversationId: string;
  myUserId: string;
  peerUserId: string;
  peerUsername: string;
}) {
  const { config } = useRuntime();
  const host = config.chatSticky;
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!host) return;
    let alive = true;
    host
      .list()
      .then((ids) => {
        if (alive) setPinned(ids.includes(props.threadId));
      })
      .catch(() => {
        // IPC hiccup — leave the toggle in its default state; the user can
        // click to override and the next render will reconcile.
      });
    return () => {
      alive = false;
    };
  }, [host, props.threadId]);

  if (!host) return null;

  const toggle = () => {
    if (pinned) {
      host.unpin(props.threadId);
      setPinned(false);
    } else {
      host.pin({
        threadId: props.threadId,
        conversationId: props.conversationId,
        myUserId: props.myUserId,
        peerUserId: props.peerUserId,
        peerUsername: props.peerUsername,
      });
      setPinned(true);
    }
  };

  return (
    <button
      onClick={toggle}
      className={`rounded-lg p-1.5 transition-colors ${
        pinned
          ? "bg-accent-soft text-accent"
          : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
      title={pinned ? "Unpin from desktop" : "Pin to desktop"}
    >
      {pinned ? <Pin size={16} /> : <PinOff size={16} />}
    </button>
  );
}
