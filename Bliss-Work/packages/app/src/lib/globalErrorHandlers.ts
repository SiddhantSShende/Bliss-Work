/**
 * Catch errors that React's ErrorBoundary doesn't see:
 *   - Synchronous errors in event listeners (window.onerror)
 *   - Rejected promises whose rejections weren't awaited (unhandledrejection)
 *
 * We toast the user (sonner) and log to console. At 1B DAU you'd swap the
 * `report` body for Sentry.captureException — keeping it pluggable here.
 */
import { toast } from "sonner";
import { ApiError } from "@taskboard/shared";

let installed = false;

export function installGlobalErrorHandlers(): void {
  // Multiple App mounts (StrictMode, Fast Refresh) would otherwise stack
  // listeners; the guard keeps a single handler per page lifetime.
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    report(event.error ?? new Error(event.message), "window.onerror");
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    report(err, "unhandledrejection");
  });
}

function report(error: unknown, source: string): void {
   
  console.error(`[${source}]`, error);

  // Don't toast on the common case of an ApiError that the React Query
  // mutation handler already toasted. We assume any thrown ApiError is
  // already user-visible somewhere (form, optimistic rollback, etc.).
  if (error instanceof ApiError) return;

  const message = error instanceof Error ? error.message : String(error);
  toast.error("Something went wrong", { description: message });
}
