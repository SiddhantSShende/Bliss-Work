/**
 * Browser-only floating sticky notes — the in-browser equivalent of the
 * Electron always-on-top sticky window.
 *
 * Lifecycle a task moves through on the screen
 * ---------------------------------------------
 *   1. **Allocated** (status: SENT) → sticky pops up the moment the
 *      allocation event arrives. Two icon buttons:
 *        • Check  → Acknowledge: server records ACK, sticky stays.
 *        • X      → Ignore: server records IGNORE, allocator gets a toast
 *                   + notification + inbox update. Sticky vanishes locally.
 *   2. **Acknowledged** (status: ACKNOWLEDGED) → sticky stays put with a
 *      single PinOff button.
 *        • PinOff → Unpin (client-side only). The task remains
 *          ACKNOWLEDGED on the server and still appears in /app/tasks. The
 *          sticky disappears from the overlay until the user explicitly
 *          re-acknowledges (rare).
 *   3. **Completed** (from /app/tasks → "Allocated to me" card → Complete)
 *      → task drops out of /tasks/sticky on the server, so the next refetch
 *      removes any lingering sticky. Notification fires to the allocator
 *      via notification-svc.
 *
 * Why no Complete in the sticky
 * ------------------------------
 * Completing a task is the deliberate "done" step and shouldn't live on a
 * floating note where a stray click could fire it. The product flow is:
 * Acknowledge from anywhere → work on it → go to Tasks → Complete. The
 * sticky is a *commitment marker*, not a one-tap completion surface.
 *
 * Source of truth
 * ----------------
 * `qk.sticky` cache. The server returns SENT + ACKNOWLEDGED rows; we show
 * both, filtered by the local "unpinned" set so a user-clicked Unpin
 * survives across refresh.
 *
 * Theming + drag
 * --------------
 * All colours come from CSS variables — auto-adapts to ThemeProvider's
 * light/dark. The whole card is the drag region; buttons opt out with
 * `data-no-drag`. A 4-pixel movement threshold distinguishes click from
 * drag so taps on the body never accidentally move the note.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Check, X, PinOff, Minus, Maximize2, Pin, ChevronLeft, ChevronRight } from "lucide-react";
import { actionsFor, ApiError, type StickyTaskDTO } from "@taskboard/shared";
import { IconButton as SharedIconButton } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useSession } from "../store/session";
import {
  consumeBrowserTaskSelection,
  unpinBrowserTask,
  useBrowserTaskPinState,
} from "../lib/browserStickyState";

const POSITION_KEY = "tb.browser-stickies.v1";
const NOTE_W = 280;
const NOTE_H = 220;
const PILL_W = 220;
const PILL_H = 48;
const PAD = 12;
/** Pixels the pointer must move before we treat the gesture as a drag.
 *  Below the threshold the gesture is a click. */
const DRAG_THRESHOLD = 4;
/** A just-completed/ignored task is held out of the visible set for this
 *  long so a stale refetch can't revive the sticky after the user dismissed
 *  it. The WS echo + invalidate normally lands well inside this window. */
const SETTLE_MS = 5_000;

interface NoteState {
  collapsed: boolean;
  x: number;
  y: number;
}

type PositionMap = Record<string, NoteState>;
type UnpinnedSet = Record<string, true>;

/**
 * There is deliberately no exported "dismiss this note from anywhere" helper.
 *
 * One existed, MailTask called it whenever a task was opened, and because it
 * wrote to localStorage the note stayed gone across every refresh — so reading
 * an allocation retired its note permanently while the task was still
 * outstanding. Taking a note off screen is now the note's own X, held in
 * component state for this session only (see `unpinned` below), and the only
 * permanent removal is a terminal status on the server.
 */

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing / quota */
  }
}

function defaultPosition(index: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 0, y: 0 };
  const x = window.innerWidth - NOTE_W - PAD;
  const y = window.innerHeight - NOTE_H - PAD - index * (NOTE_H + PAD);
  return { x: Math.max(PAD, x), y: Math.max(PAD, y) };
}

function clampToViewport(
  pos: { x: number; y: number },
  collapsed: boolean,
): { x: number; y: number } {
  if (typeof window === "undefined") return pos;
  const w = collapsed ? PILL_W : NOTE_W;
  const h = collapsed ? PILL_H : NOTE_H;
  return {
    x: Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - w)),
    y: Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - h)),
  };
}

export function BrowserStickies() {
  const { t } = useTranslation("stickies");
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const authed = useSession((s) => s.status === "authed");
  const location = useLocation();
  // Don't render in Electron — real OS sticky windows cover that surface.
  const isElectron = !!config.pinTask;
  // App-wide: a task assigned while the user is on a chat/channel/tasks/settings
  // page must still pop as a sticky the instant it arrives — not only on the
  // inbox/home screen. So float across every authenticated /app/* route.
  const inApp = location.pathname.startsWith("/app");
  const enabled = authed && !isElectron && inApp;

  const { data: tasks = [], isSuccess } = useQuery({
    queryKey: qk.sticky,
    queryFn: () => api.tasksSticky(),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const [positionMap, setPositionMap] = useState<PositionMap>(() =>
    readJSON(POSITION_KEY, {}),
  );
  // Notes the user took off screen THIS SESSION. Deliberately seeded empty and
  // never persisted: a reload is a new session, so an outstanding task's note
  // comes back, and the only permanent removal is completing or ignoring the
  // task. This used to be a localStorage set, which combined with the (now
  // removed) dismiss-on-open call meant reading a task retired its note for
  // good — see the note in packages/app/src/platform.ts.
  const browserPinState = useBrowserTaskPinState();
  const unpinnedIds = browserPinState.unpinnedIds;
  const unpinned = useMemo<UnpinnedSet>(
    () => Object.fromEntries(unpinnedIds.map((id) => [id, true])),
    [unpinnedIds],
  );

  useEffect(() => writeJSON(POSITION_KEY, positionMap), [positionMap]);

  // Tasks the user just acted on locally. Held back from the visible set so
  // an in-flight refetch can't briefly revive the note after a dismiss.
  const settledRef = useRef<Set<string>>(new Set());

  const settle = useCallback((taskId: string) => {
    settledRef.current.add(taskId);
    window.setTimeout(() => settledRef.current.delete(taskId), SETTLE_MS);
  }, []);

  const eligibleTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (task.myStatus === "SENT" || task.myStatus === "ACKNOWLEDGED") &&
          !unpinned[task.taskId] &&
          !settledRef.current.has(task.taskId),
      ),
    [tasks, unpinned],
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const previousEligibleIds = useRef<string[]>([]);

  useEffect(() => {
    const requestedTaskId = consumeBrowserTaskSelection();
    if (requestedTaskId) setSelectedTaskId(requestedTaskId);
  }, [browserPinState.requestedTaskId]);

  // Preserve the selected task while it remains eligible. If it disappears,
  // keep the same carousel index so the next valid task takes its place.
  useEffect(() => {
    setSelectedTaskId((current) => {
      if (eligibleTasks.length === 0) return null;
      if (current && eligibleTasks.some((task) => task.taskId === current)) return current;
      const previousIndex = current ? previousEligibleIds.current.indexOf(current) : -1;
      return eligibleTasks[previousIndex >= 0 ? previousIndex % eligibleTasks.length : 0]!.taskId;
    });
    previousEligibleIds.current = eligibleTasks.map((task) => task.taskId);
  }, [eligibleTasks]);

  const activeTask =
    eligibleTasks.find((task) => task.taskId === selectedTaskId) ?? eligibleTasks[0] ?? null;
  const switchTask = useCallback(
    (direction: -1 | 1) => {
      if (eligibleTasks.length < 2 || !activeTask) return;
      const index = eligibleTasks.findIndex((task) => task.taskId === activeTask.taskId);
      setSelectedTaskId(
        eligibleTasks[(index + direction + eligibleTasks.length) % eligibleTasks.length]!.taskId,
      );
    },
    [activeTask, eligibleTasks],
  );

  // GC stale persisted entries when their task disappears from the server.
  //
  // Gated on a SUCCESSFUL fetch, which is the whole correctness condition here.
  // `tasks` defaults to [], and this effect also runs when the query is
  // disabled (Electron, or before sign-in), so without the gate every stored
  // key looked stale on a cold mount and the saved positions were wiped on
  // every page load. Same rule the desktop already follows for prunePinned:
  // only a live list may retire anything.
  useEffect(() => {
    if (!enabled || !isSuccess) return;
    const liveIds = new Set(tasks.map((task) => task.taskId));
    setPositionMap((prev) => {
      const stale = Object.keys(prev).filter((k) => !liveIds.has(k));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [tasks, enabled, isSuccess]);

  const patchState = useCallback((id: string, patch: Partial<NoteState>) => {
    setPositionMap((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { collapsed: false, x: 0, y: 0 }), ...patch },
    }));
  }, []);

  const refreshAllSurfaces = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.sticky });
    void qc.invalidateQueries({ queryKey: qk.inbox });
    void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
    void qc.invalidateQueries({ queryKey: qk.assigned });
    void qc.invalidateQueries({ queryKey: qk.sent });
    void qc.invalidateQueries({ queryKey: qk.notifications });
    void qc.invalidateQueries({ queryKey: qk.inboxPeers });
    void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
  }, [qc]);

  // ── Acknowledge ────────────────────────────────────────────────────────
  // Optimistically patch the cached row to ACKNOWLEDGED so the sticky's
  // button set flips immediately. Roll back on error.
  const ackMut = useMutation({
    mutationFn: (taskId: string) => api.taskAction(taskId, "acknowledge"),
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: qk.sticky });
      const previous = qc.getQueryData<StickyTaskDTO[]>(qk.sticky);
      qc.setQueryData<StickyTaskDTO[]>(qk.sticky, (prev) =>
        (prev ?? []).map((task) =>
          task.taskId === taskId
            ? { ...task, myStatus: "ACKNOWLEDGED" as const, actions: actionsFor("ACKNOWLEDGED") }
            : task,
        ),
      );
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.sticky, ctx.previous);
      toast.error(err instanceof ApiError ? err.message : t("toasts.acknowledgeFailed"));
    },
    onSuccess: () => refreshAllSurfaces(),
  });

  // ── Ignore ─────────────────────────────────────────────────────────────
  // Removes the task from the user's actionable set. The server emits
  // TaskIgnored → notification-svc materialises a notification for the
  // allocator + the inbox row updates via WS for both sides.
  const ignoreMut = useMutation({
    mutationFn: (taskId: string) => api.taskAction(taskId, "ignore"),
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: qk.sticky });
      const previous = qc.getQueryData<StickyTaskDTO[]>(qk.sticky);
      qc.setQueryData<StickyTaskDTO[]>(qk.sticky, (prev) =>
        (prev ?? []).filter((task) => task.taskId !== taskId),
      );
      settle(taskId);
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.sticky, ctx.previous);
      toast.error(err instanceof ApiError ? err.message : t("toasts.ignoreFailed"));
    },
    onSuccess: () => {
      toast.success(t("toasts.taskIgnored"));
      refreshAllSurfaces();
    },
  });

  // ── Unpin (client-side only) ───────────────────────────────────────────
  // The task stays ACKNOWLEDGED on the server; it just stops floating on
  // this client. No network call. The user completes it from /app/tasks.
  const unpinLocally = useCallback(
    (taskId: string) => {
      unpinBrowserTask(taskId);
      toast(t("toasts.noteUnpinned"), {
        description: t("toasts.noteUnpinnedDescription"),
      });
    },
    [t],
  );

  // ── Force-close (safety net) ───────────────────────────────────────────
  // Some flows (a stale cache after a server-side complete that the WS echo
  // missed, a sticky from a session whose access token has since expired)
  // can leave a note that the normal Acknowledge / Ignore / Unpin buttons
  // can't address. The X in the header always removes the note locally
  // without server side-effects, so the user is never trapped.
  const hideLocally = useCallback(
    (taskId: string) => {
      unpinBrowserTask(taskId);
      // No toast — the user is dismissing, they don't want another popup.
    },
    [],
  );

  if (!enabled || !activeTask) return null;
  const activeState = positionMap[activeTask.taskId];
  const initialPosition = activeState
    ? clampToViewport(
        { x: activeState.x, y: activeState.y },
        activeState.collapsed,
      )
    : defaultPosition(0);

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[200]"
      aria-label={t("overlay.ariaLabel")}
    >
      <AnimatePresence>
        <FloatingNote
          key="web-task-pin"
          task={activeTask}
          collapsed={activeState?.collapsed ?? false}
          initialPosition={initialPosition}
          busy={
            (ackMut.isPending && ackMut.variables === activeTask.taskId) ||
            (ignoreMut.isPending && ignoreMut.variables === activeTask.taskId)
          }
          onPositionSettled={(p) => patchState(activeTask.taskId, p)}
          onCollapse={() => patchState(activeTask.taskId, { collapsed: true })}
          onExpand={() => patchState(activeTask.taskId, { collapsed: false })}
          onAcknowledge={() => ackMut.mutate(activeTask.taskId)}
          onIgnore={() => ignoreMut.mutate(activeTask.taskId)}
          onUnpin={() => unpinLocally(activeTask.taskId)}
          onHide={() => hideLocally(activeTask.taskId)}
          hasMultiple={eligibleTasks.length > 1}
          onPrevious={() => switchTask(-1)}
          onNext={() => switchTask(1)}
        />
      </AnimatePresence>
    </div>
  );
}

interface FloatingNoteProps {
  task: StickyTaskDTO;
  collapsed: boolean;
  initialPosition: { x: number; y: number };
  busy: boolean;
  onPositionSettled: (pos: { x: number; y: number }) => void;
  onCollapse: () => void;
  onExpand: () => void;
  onAcknowledge: () => void;
  onIgnore: () => void;
  onUnpin: () => void;
  onHide: () => void;
  hasMultiple: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

function FloatingNote({
  task,
  collapsed,
  initialPosition,
  busy,
  onPositionSettled,
  onCollapse,
  onExpand,
  onAcknowledge,
  onIgnore,
  onUnpin,
  onHide,
  hasMultiple,
  onPrevious,
  onNext,
}: FloatingNoteProps) {
  const { t } = useTranslation("stickies");
  const isSent = task.myStatus === "SENT";
  const [isCollapsed, setIsCollapsed] = useState(collapsed);
  const [pos, setPos] = useState(() => clampToViewport(initialPosition, collapsed));

  useEffect(() => {
    const onResize = () => setPos((p) => clampToViewport(p, isCollapsed));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isCollapsed]);

  /** Drag state: idle → press → drag. Threshold-based to keep button clicks
   *  intact even when fired from inside the draggable surface. */
  const drag = useRef<{
    phase: "idle" | "press" | "drag";
    startX: number;
    startY: number;
    origin: { x: number; y: number };
    pointerId: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-no-drag]")) return;
    drag.current = {
      phase: "press",
      startX: e.clientX,
      startY: e.clientY,
      origin: pos,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.phase === "press") {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      d.phase = "drag";
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture may be denied — drag still works */
      }
    }
    setPos(clampToViewport({ x: d.origin.x + dx, y: d.origin.y + dy }, isCollapsed));
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.phase === "drag") {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      onPositionSettled(pos);
    }
    drag.current = null;
  };

  const interactionProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    style: {
      position: "fixed" as const,
      left: pos.x,
      top: pos.y,
      touchAction: "none" as const,
      userSelect: "none" as const,
    },
  };

  if (isCollapsed) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.94 }}
        transition={{ type: "spring", stiffness: 360, damping: 28 }}
        {...interactionProps}
        style={{ ...interactionProps.style, width: PILL_W, height: PILL_H }}
        className="pointer-events-auto cursor-grab active:cursor-grabbing"
      >
        <div
          className="relative flex h-full items-center gap-2 rounded-2xl border border-border bg-surface px-3 shadow-widget"
          title={task.title}
        >
          {hasMultiple && (
            <>
              <PinNavButton direction="previous" onClick={onPrevious} />
              <PinNavButton direction="next" onClick={onNext} />
            </>
          )}
          <Pin size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
            {task.title || t("card.untitledTask")}
          </span>
          <IconButton
            onClick={() => {
              setIsCollapsed(false);
              onExpand();
            }}
            title={t("card.expand")}
            label={t("card.expandLabel")}
          >
            <Maximize2 size={13} />
          </IconButton>
          <IconButton onClick={onHide} title={t("card.dismiss")} label={t("card.dismissLabel")}>
            <X size={13} />
          </IconButton>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ type: "spring", stiffness: 360, damping: 28 }}
      {...interactionProps}
      style={{ ...interactionProps.style, width: NOTE_W }}
      className="pointer-events-auto cursor-grab active:cursor-grabbing"
    >
      <div className="relative flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3 shadow-widget">
        {hasMultiple && (
          <>
            <PinNavButton direction="previous" onClick={onPrevious} />
            <PinNavButton direction="next" onClick={onNext} />
          </>
        )}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-1.5">
            <Pin size={13} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0 line-clamp-2 text-sm font-semibold text-fg">
              {task.title || t("card.untitledTask")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              onClick={() => {
                setIsCollapsed(true);
                onCollapse();
              }}
              title={t("card.collapse")}
              label={t("card.collapseLabel")}
            >
              <Minus size={14} />
            </IconButton>
            <IconButton onClick={onHide} title={t("card.dismiss")} label={t("card.dismissLabel")}>
              <X size={14} />
            </IconButton>
          </div>
        </div>

        {task.senderUsername && (
          <div className="text-[11px] text-muted">{t("card.from", { name: task.senderUsername })}</div>
        )}
        {task.description && (
          <p className="max-h-16 overflow-y-auto whitespace-pre-wrap text-[12px] leading-snug text-fg/80 [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]">
            {task.description}
          </p>
        )}

        {isSent ? (
          // ── Allocated, not yet acknowledged ────────────────────────────
          <div className="grid grid-cols-2 gap-2">
            <ActionButton
              onClick={onIgnore}
              disabled={busy}
              tone="danger"
              title={t("card.ignoreTitle")}
            >
              <X size={14} /> {t("card.ignore")}
            </ActionButton>
            <ActionButton
              onClick={onAcknowledge}
              disabled={busy}
              tone="accent"
              title={t("card.acknowledgeTitle")}
            >
              <Check size={14} /> {t("card.acknowledge")}
            </ActionButton>
          </div>
        ) : (
          // ── Acknowledged: only an Unpin escape hatch ───────────────────
          <ActionButton
            onClick={onUnpin}
            disabled={busy}
            tone="ghost"
            title={t("card.unpinFromDesktopTitle")}
          >
            <PinOff size={14} /> {t("card.unpin")}
          </ActionButton>
        )}
      </div>
    </motion.div>
  );
}

/** Small icon-only button shared by both states — a thin wrapper around
 *  packages/ui's IconButton. `data-no-drag` so a tap inside it fires its
 *  click instead of starting a drag; the sizing/shape override (h-auto w-auto
 *  ... rounded-lg) keeps this note's compact button size instead of the
 *  shared component's default h-9 w-9 rounded-xl. */
function IconButton({
  children,
  onClick,
  title,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  label: string;
}) {
  return (
    <SharedIconButton
      data-no-drag
      onClick={onClick}
      title={title}
      aria-label={label}
      className="h-auto w-auto shrink-0 rounded-lg p-1 transition"
    >
      {children}
    </SharedIconButton>
  );
}

function PinNavButton({
  direction,
  onClick,
}: {
  direction: "previous" | "next";
  onClick: () => void;
}) {
  const { t } = useTranslation("stickies");
  const previous = direction === "previous";
  const label = t(previous ? "card.navPrevious" : "card.navNext");
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`app-no-drag absolute top-1/2 z-10 flex h-6 w-5 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg ${
        previous ? "-left-5" : "-right-5"
      }`}
    >
      {previous ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
    </button>
  );
}

/** Tone-styled action button. Tones map to the canonical UI palette so
 * light/dark are automatic via CSS variables. */
function ActionButton({
  children,
  onClick,
  disabled,
  tone,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone: "accent" | "danger" | "ghost";
  title: string;
}) {
  const tones = {
    accent: "bg-accent text-accent-fg hover:bg-accent-strong",
    danger: "bg-danger text-white hover:brightness-110",
    ghost: "border border-border text-fg hover:bg-surface-2",
  } as const;
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium shadow-soft transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
