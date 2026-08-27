import { Suspense, lazy } from "react";
import type { CallDTO } from "@taskboard/shared";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * How long the chunk fetch gets before this treats it as failed rather than
 * merely slow. Matched to LiveKit's own internal connect timeout (~15s) so
 * the worst case across the whole join flow — chunk load, then the room's
 * own connect — sits on a consistent scale.
 */
const CHUNK_LOAD_TIMEOUT_MS = 15_000;

/**
 * Turn a STALLED (never resolves, never rejects) dynamic import into a real
 * rejection, so Suspense/ErrorBoundary have something to settle on.
 *
 * A hard refresh is exactly the moment this matters: it wipes the whole
 * module graph AND every Service Worker/Cache Storage entry (see
 * apps/web/src/main.tsx's self-heal on load), so `import("./CallRoom")` is
 * always a genuine cold network fetch — right when the page's own network
 * stack is coldest. Without this, a request that stalls rather than
 * outright failing left CallRoomFallback's "Connecting…" on screen forever:
 * the app's only other chunk-recovery mechanism, chunkReloadRecovery.ts,
 * reacts solely to Vite's `vite:preloadError` event, which fires on an
 * outright load FAILURE, never on a hang.
 */
function withLoadTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out loading the meeting room")),
      CHUNK_LOAD_TIMEOUT_MS,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

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
  withLoadTimeout(import("./CallRoom").then((m) => ({ default: m.CallRoom }))),
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
 * Shown when the chunk load timed out (see `withLoadTimeout`) or the loaded
 * module threw while rendering. Offers a page reload, not an in-place retry:
 * `React.lazy` caches its loader's promise for good once it settles, so a
 * rejected `LazyCallRoom` can never be retried within the same page session
 * — the same reasoning `chunkReloadRecovery.ts` already documents for the
 * same class of failure ("reloading once fetches a fresh index.html and the
 * current chunk hashes").
 */
function CallRoomLoadError() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-surface p-6 text-center">
      <div className="text-sm font-medium text-fg">Something went wrong opening the meeting room.</div>
      <div className="max-w-xs text-xs text-muted">Reloading the page usually fixes this.</div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium hover:bg-surface-3"
      >
        Reload
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
export function CallRoom(props: { call: CallDTO; onClose: () => void }) {
  return (
    <ErrorBoundary fallback={() => <CallRoomLoadError />}>
      <Suspense fallback={<CallRoomFallback />}>
        <LazyCallRoom {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
