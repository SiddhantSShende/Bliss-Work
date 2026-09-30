/**
 * Keeps one <CallTile> — and therefore one <video> element, one
 * track.attach() — alive per participant for as long as they are visible
 * ANYWHERE in the room, while the LAYOUT that decides WHERE they appear (the
 * paged grid, the pinned/speaking stage, the filmstrip, the grid's own
 * solo/multi split) keeps changing structurally underneath them.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * CallRoom's stage/grid ternary, CallMembers' own solo/grid ternary, and
 * CallSpeakerFilmstrip's pool are three DIFFERENT branches of the render
 * tree. Moving a participant between them — becoming the active speaker,
 * getting pinned, a screen share starting, the room going from one
 * participant to two — is a type change at that position in the tree, and
 * React cannot reuse a DOM node across a type change: it unmounts the old
 * <CallTile> (detaching the track) and mounts a fresh one (re-attaching it),
 * even though nothing about the participant or their media actually changed.
 * That remount is a real, visible interruption on every layout change, not
 * just the setup for some other bug.
 *
 * ── Why a plain portal is not enough ─────────────────────────────────────────
 * The obvious fix is one <CallTile> per identity, portaled to whichever slot
 * currently wants it, retargeting `createPortal`'s own `container` argument
 * as the slot moves. That does NOT work: verified directly (an isolated
 * render/rerender with a stable `key` and only the portal's `container`
 * changed) that React treats a changed portal container as a reason to
 * unmount and remount the children, key or no key — a portal's target node
 * is effectively part of its identity, not an updatable prop.
 *
 * ── The fix: one PERMANENT home per identity, moved by hand ──────────────────
 * Each identity gets a `home` — a plain `<div>`, created once and kept for as
 * long as that identity has any slot claiming it, sized to fill whatever
 * contains it. `<CallTile>` is portaled into `home`, and `home` itself NEVER
 * changes for that identity — so as far as React's own reconciliation is
 * concerned, this portal's container never changes, and it never has a
 * reason to remount what's inside it. Separately, after every render, a
 * plain `target.appendChild(home)` moves `home` — the whole node, not its
 * child — into whichever slot's container currently claims that identity.
 *
 * Moving `home` itself, rather than reaching inside it to move its child,
 * matters: an earlier version of this moved CallTile's own root element out
 * of `home` directly, and React's own cleanup later failed with "the node to
 * be removed is not a child of this node" — react-dom tracks a rendered
 * node's container and calls `container.removeChild(node)` against it
 * directly, so if something else has already relocated the node elsewhere,
 * that call breaks. `home` is the one node React's portal machinery actually
 * owns and everything React renders stays inside it and never leaves; only
 * `home` ITSELF — a node React never tries to remove on its own, since
 * nothing portals INTO it from outside — gets physically relocated. The
 * mounted React state inside `home` (the <video> element, whatever
 * MediaStreamTrack is attached to it) survives completely undisturbed; only
 * its visual position changes.
 *
 * A slot moving to a new container claims the identity there; the slot it
 * left releases it — but `release` defers its own check-and-delete to a
 * microtask, because React runs a removed subtree's effect cleanup BEFORE a
 * newly-inserted subtree's effect setup (verified directly), so an
 * immediate, synchronous release would see the OLD claim still in place and
 * delete it before the new one ever lands. By the time the deferred release
 * actually runs, a same-tick new claim has already updated the registration,
 * and release's guard (it only ever clears a registration whose container
 * still matches the one releasing) sees that and does nothing. A release
 * with no matching new claim — a genuine departure — still runs, just a
 * microtask later, which deletes that entry's `home` too, letting the
 * portaled <CallTile> unmount for real.
 *
 * ── Keyed by identity AND source, not identity alone ─────────────────────────
 * A screen-sharer occupies two slots at once, on purpose (see
 * CallSpeakerFilmstrip's own doc): the stage shows their screen, and the
 * filmstrip re-includes them showing their CAMERA (`source="camera"`) so
 * their face doesn't disappear just because their screen is what is on
 * stage. Those are two genuinely different tiles that happen to share a
 * participant, not the same tile moving — keying the registry by identity
 * alone would let the second claim clobber the first (whichever slot claims
 * last would win, and the other would silently vanish). The registry key is
 * `${identity}:${source}` instead, so the ordinary tile (`source: "auto"`,
 * the overwhelmingly common case — everyone who is not simultaneously
 * sharing while also being shown elsewhere) and a sharer's separate
 * camera-only copy never collide, while each is independently exactly as
 * stable across layout moves as identity alone would have made it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CallTile } from "./CallTile";
import type { RoomParticipant } from "../lib/useCallRoom";

/** Exactly CallTile's own props — CallTileSlot is a drop-in replacement for
 *  rendering it directly, so it takes nothing more and nothing less. */
interface TileProps {
  p: RoomParticipant;
  size?: "stage" | "grid" | "strip";
  pinned?: boolean;
  active?: boolean;
  handRaised?: boolean;
  onTogglePin?: () => void;
  source?: "auto" | "camera";
}

interface Registration {
  /** Never changes for a given identity — see the module doc. */
  home: HTMLDivElement;
  /** The slot's own div — where `home`'s content should visually live. */
  target: HTMLDivElement;
  props: TileProps;
}

interface RegistryApi {
  claim: (key: string, target: HTMLDivElement, props: TileProps) => void;
  release: (key: string, target: HTMLDivElement) => void;
}

/** `identity` alone is not a safe registry key — see the module doc's "Keyed
 *  by identity AND source" section. */
function registryKey(p: RoomParticipant, source: TileProps["source"]): string {
  return `${p.identity}:${source ?? "auto"}`;
}

const Ctx = createContext<RegistryApi | null>(null);

/** Mount once per room (CallRoom itself), wrapping the whole video area —
 *  the stage, the grid, and the filmstrip all need to share this one
 *  registry so a tile can move between them without remounting. */
export function CallTileHostProvider({ children }: { children: ReactNode }) {
  const [regs, setRegs] = useState<Map<string, Registration>>(() => new Map());
  // Persists across renders independent of `regs` itself, so a `home`
  // survives being read/written by claim/release without living in state.
  const homes = useRef(new Map<string, HTMLDivElement>());

  const claim = useCallback((key: string, target: HTMLDivElement, props: TileProps) => {
    setRegs((prev) => {
      let home = homes.current.get(key);
      if (!home) {
        home = document.createElement("div");
        // Fills whichever slot currently owns it — CallTile's own root
        // element already assumes a definite-size parent (`h-full w-full`).
        home.style.width = "100%";
        home.style.height = "100%";
        homes.current.set(key, home);
      }
      const next = new Map(prev);
      next.set(key, { home, target, props });
      return next;
    });
  }, []);

  const release = useCallback((key: string, target: HTMLDivElement) => {
    queueMicrotask(() => {
      setRegs((prev) => {
        const current = prev.get(key);
        if (!current || current.target !== target) return prev;
        homes.current.delete(key);
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    });
  }, []);

  const api = useMemo<RegistryApi>(() => ({ claim, release }), [claim, release]);

  // The actual relocation: after every render, make sure each identity's
  // already-rendered DOM (living inside its own stable, detached `home`) is
  // physically parented under whichever slot currently claims it. Plain
  // node.appendChild() — React never sees this as a remove-and-recreate, so
  // it never has a reason to unmount the CallTile whose root element this
  // is, wherever it ends up in the document.
  useLayoutEffect(() => {
    for (const { home, target } of regs.values()) {
      if (home.parentElement !== target) target.appendChild(home);
    }
  });

  return (
    <Ctx.Provider value={api}>
      {children}
      {[...regs].map(([key, { home, props }]) => createPortal(<CallTile key={key} {...props} />, home))}
    </Ctx.Provider>
  );
}

/**
 * Drop-in replacement for rendering `<CallTile {...tileProps} />` directly:
 * same props, plus `className`/`style` for the positioning wrapper this
 * renders instead — the same box every call site already wrapped its own
 * CallTile in (a grid cell, the solo/stage inset-0 box, a filmstrip
 * thumbnail). Falls back to rendering CallTile inline, with no portal, when
 * there is no provider above it (a standalone unit-test harness, most
 * likely) — so this is safe to use everywhere CallTile itself was used, not
 * only inside a room.
 */
export function CallTileSlot({
  className,
  style,
  ...tileProps
}: TileProps & { className?: string; style?: CSSProperties }) {
  const api = useContext(Ctx);
  const ref = useRef<HTMLDivElement>(null);
  const key = registryKey(tileProps.p, tileProps.source);

  // Claim/update on every render — cheap, and it's what keeps the portaled
  // CallTile's props (pinned, active, size, source, handRaised) in sync with
  // this slot's own as they change.
  useLayoutEffect(() => {
    const el = ref.current;
    if (api && el) api.claim(key, el, tileProps);
  });

  // Release ONLY on this slot's real unmount, never on an ordinary
  // re-render — see the module doc for why that, plus release's own
  // microtask deferral, is what makes a moving tile safe regardless of
  // effect order.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (api && el) api.release(key, el);
    };
  }, [api, key]);

  // No provider above: fall back to the exact box every call site used to
  // wrap CallTile in directly.
  if (!api) {
    return (
      <div className={className} style={style}>
        <CallTile {...tileProps} />
      </div>
    );
  }
  return <div ref={ref} className={className} style={style} />;
}
