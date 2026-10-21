import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import type { CallDTO } from "@taskboard/shared";
import { ErrorBoundary } from "./ErrorBoundary";
import { withLoadTimeout } from "../lib/withLoadTimeout";

/**
 * How long the chunk fetch gets before this treats it as failed rather than
 * merely slow. Matched to LiveKit's own internal connect timeout (~15s) so
 * the worst case across the whole join flow — chunk load, then the room's
 * own connect — sits on a consistent scale. See withLoadTimeout's own doc
 * for why a hard refresh makes this matter at all.
 */
const CHUNK_LOAD_TIMEOUT_MS = 15_000;

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
  withLoadTimeout(
    import("./CallRoom").then((m) => ({ default: m.CallRoom })),
    CHUNK_LOAD_TIMEOUT_MS,
    "Timed out loading the meeting room",
  ),
);

/**
 * The fallback is deliberately quiet.
 *
 * This renders for the few hundred milliseconds it takes to fetch the call
 * chunk, and it replaces a surface the user has just chosen to open. A spinner
 * that flashes and vanishes is worse than a still frame, so this is a calm
 * placeholder on the same dark ground the call UI uses — the transition reads
 * as the room opening rather than as something loading.
 *
 * `fixed inset-0 z-[100]` (matching CallRoom's own top-level positioning) is
 * load-bearing, not decorative: MeetingHost renders `<CallRoom>` as a plain
 * sibling AFTER whatever the router rendered (App.tsx), with nothing giving
 * it an overlay context of its own — it relies entirely on this component's
 * own positioning. Without it, this rendered in NORMAL DOCUMENT FLOW below
 * the current route's content instead of over it: on /call/:callId that put
 * it a full viewport-height scroll below CallWindow's own "Joining the
 * meeting…" placeholder, invisible unless the user happened to scroll past
 * it — indistinguishable from the chunk never loading at all.
 */
function CallRoomFallback() {
  const { t } = useTranslation("calls");
  return (
    <div className="meeting-surface meeting-mesh fixed inset-0 z-[100] flex items-center justify-center text-sm text-muted">
      {t("roomLazy.connecting")}
    </div>
  );
}

/**
 * Shown when the chunk load timed out (see `withLoadTimeout`) or the loaded
 * module threw while rendering. Offers a page reload, not an in-place retry:
 * `React.lazy` caches its loader's promise for good once it settles, so a
 * rejected `LazyCallRoom` can never be retried within the same page session
 * — the same reasoning `chunkReloadRecovery.ts` already documents for the
 * same class of failure ("reloading once fetches a fresh index.html and the
 * current chunk hashes").
 *
 * `fixed inset-0 z-[100]` for the same reason as CallRoomFallback above: this
 * has no overlay context of its own from MeetingHost, so without it the
 * Reload button this exists to offer rendered off-screen, not merely
 * unstyled.
 */
function CallRoomLoadError() {
  const { t } = useTranslation("calls");
  return (
    <div className="meeting-surface meeting-mesh fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-sm font-medium text-fg">{t("roomLazy.error.title")}</div>
      <div className="max-w-xs text-xs text-muted">{t("roomLazy.error.hint")}</div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium hover:bg-surface-3"
      >
        {t("roomLazy.error.reload")}
      </button>
    </div>
  );
}

/**
 * Drop-in replacement for `CallRoom`. Same props, same behaviour, except that
 * the code arrives on demand.
 *
 * Wrapped in its OWN `ErrorBoundary` rather than relying on the app-wide one
 * (App.tsx): nothing between here and there caught a lazy-import rejection
 * before this existed, so a stalled/failed chunk load — or a runtime error
 * inside the loaded room — blanked far more of the app than just the room.
 */
export function CallRoom(props: { call: CallDTO; onClose: () => void; autoJoin?: "video" | "voice" }) {
  return (
    <ErrorBoundary fallback={() => <CallRoomLoadError />}>
      <Suspense fallback={<CallRoomFallback />}>
        <LazyCallRoom {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
