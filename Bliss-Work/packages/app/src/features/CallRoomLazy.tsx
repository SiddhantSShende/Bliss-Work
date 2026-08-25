import { Suspense, lazy } from "react";
import type { CallDTO } from "@taskboard/shared";

/**
 * `CallRoom`, loaded only when somebody is actually in a call.
 *
 * ── Why this wrapper exists ──────────────────────────────────────────────────
 * `CallRoom` statically imports `useCallRoom`, which statically imports
 * `livekit-client` — the entire WebRTC SFU client. Four modules import CallRoom
 * directly (CallUI, Meetings, JoinCallView, ChannelView), and CallUI is mounted
 * globally by the app shell, so that import chain reached essentially every
 * route. The result was that `livekit-client` sat in the ENTRY chunk: every
 * visitor downloaded and parsed the video-call stack before they could see a
 * login form, whether or not they ever placed a call.
 *
 * A dynamic `import()` is what actually moves code out of a chunk — Rollup
 * cannot split a statically-reachable module no matter how `manualChunks` is
 * configured, because it has to be present before first paint. So the boundary
 * has to be here, at the one component that pulls the dependency in.
 *
 * ── Why one wrapper rather than lazy() at each call site ─────────────────────
 * Four `lazy()` calls would create four separate lazy components wrapping the
 * same module. React would treat them as distinct component types, so moving
 * between two surfaces that both render a call (a channel call, then a meeting)
 * would unmount and remount the room — tearing down the LiveKit connection and
 * rejoining. One shared lazy component keeps a single identity, so the room
 * survives.
 *
 * The named-export shape (`.then(m => ({ default: m.CallRoom }))`) is required:
 * React.lazy resolves a module's `default`, and CallRoom is a named export.
 */
const LazyCallRoom = lazy(() =>
  import("./CallRoom").then((m) => ({ default: m.CallRoom })),
);

/**
 * The fallback is deliberately quiet.
 *
 * This renders for the few hundred milliseconds it takes to fetch the call
 * chunk, and it replaces a surface the user has just chosen to open. A spinner
 * that flashes and vanishes is worse than a still frame, so this is a calm
 * placeholder on the same dark ground the call UI uses — the transition reads
 * as the room opening rather than as something loading.
 */
function CallRoomFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface text-sm text-muted">
      Connecting…
    </div>
  );
}

/**
 * Drop-in replacement for `CallRoom`. Same props, same behaviour, except that
 * the code arrives on demand.
 */
export function CallRoom(props: { call: CallDTO; onClose: () => void }) {
  return (
    <Suspense fallback={<CallRoomFallback />}>
      <LazyCallRoom {...props} />
    </Suspense>
  );
}
