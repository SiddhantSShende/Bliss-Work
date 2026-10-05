/**
 * Last-chance React error trap.
 *
 * If a child renders or commits with an exception, React unmounts the whole
 * subtree by default — the user sees a blank page with no recovery path.
 * ErrorBoundary catches the throw, renders a fallback that surfaces the
 * `requestId` (when the cause is an ApiError) so the user can paste a single
 * string into a support ticket, and offers a Retry / Go Home action.
 *
 * The boundary resets when the route changes — otherwise an error on
 * `/app/tasks` would stay visible after the user navigates to `/app/mail`.
 *
 * Production note: at 1B DAU you'd plug this into Sentry's React integration
 * via the onError prop. We expose `onError` so the integration can be wired
 * in main.tsx (web) and the Electron preload without touching this file.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ApiError } from "@taskboard/shared";

interface Props {
  children: ReactNode;
  /** Reset key — when this changes, the boundary clears its error state. */
  resetKey?: string;
  /** Optional reporter for telemetry (Sentry, etc.). */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Optional custom fallback render. */
  fallback?: (args: { error: Error; reset: () => void; requestId: string }) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log so the dev console shows the trace; report if configured.
     
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prevProps: Props): void {
    // Reset when the parent supplies a new resetKey (e.g. on route change).
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const requestId = error instanceof ApiError ? error.requestId : "";
    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset, requestId });
    }
    return <DefaultFallback error={error} reset={this.reset} requestId={requestId} />;
  }
}

function DefaultFallback({
  error,
  reset,
  requestId,
}: {
  error: Error;
  reset: () => void;
  requestId: string;
}) {
  const { t } = useTranslation("common");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-base font-semibold">{t("errorBoundary.title")}</div>
      <div className="max-w-md text-xs text-muted">
        {error instanceof ApiError ? error.message : t("errorBoundary.unexpectedError")}
      </div>
      {requestId && (
        <div className="rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted">
          {t("errorBoundary.reference", { requestId })}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium hover:bg-surface-3"
        >
          {t("errorBoundary.retry")}
        </button>
        <a
          href="/app"
          className="rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium hover:bg-surface-3"
        >
          {t("errorBoundary.goHome")}
        </a>
      </div>
    </div>
  );
}

/** Convenience wrapper that auto-resets on every route change. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}
