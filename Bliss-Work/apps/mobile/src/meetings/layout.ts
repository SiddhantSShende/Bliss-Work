import type { RoomParticipantView } from '../calls/roomController';

/**
 * Who is on the meeting's main stage, and how the rest are laid out.
 * Pure (no React, no native) so the rules are unit-tested.
 *
 * Priority for the stage, as in web's room:
 *   1. someone's shared screen (what everyone joined to look at),
 *   2. the participant the viewer pinned,
 *   3. the active speaker (most recent remote speaker),
 *   4. otherwise the first remote participant (or ourselves when alone).
 */

export type StageMode = 'alone' | 'pair' | 'speaker' | 'pinned' | 'share';

export interface StagePlan {
  mode: StageMode;
  /** Whose tile fills the stage. */
  stage: RoomParticipantView | null;
  /** True when the stage shows the shared screen rather than the camera. */
  stageIsScreen: boolean;
  /** Everyone else (thumbnails / grid), local participant last. */
  others: RoomParticipantView[];
}

export function pickStage(
  participants: readonly RoomParticipantView[],
  opts: { pinned?: string | null; lastSpokeAt?: Readonly<Record<string, number>> } = {},
): StagePlan {
  if (participants.length === 0) return { mode: 'alone', stage: null, stageIsScreen: false, others: [] };
  const byId = new Map(participants.map((p) => [p.identity, p]));
  const local = participants.find((p) => p.isLocal);
  const remotes = participants.filter((p) => !p.isLocal);
  const withRest = (stage: RoomParticipantView, keepStageThumb: boolean) => {
    const rest = participants.filter((p) => p !== stage);
    // Local last, so "you" is always the same corner.
    const ordered = [...rest.filter((p) => !p.isLocal), ...rest.filter((p) => p.isLocal)];
    return keepStageThumb ? [stage, ...ordered] : ordered;
  };

  // 1. A shared screen — someone else's. Ours is never staged: it would be our
  //    own screen echoed back inside itself (the UI shows a "you're sharing"
  //    banner instead).
  const sharer = remotes.find((p) => p.sharing && p.screenRef);
  if (sharer) {
    // The sharer's camera stays reachable as a thumbnail.
    return { mode: 'share', stage: sharer, stageIsScreen: true, others: withRest(sharer, true) };
  }

  // 2. Pinned (and still present).
  const pinned = opts.pinned ? byId.get(opts.pinned) : undefined;
  if (pinned && participants.length > 1) {
    return { mode: 'pinned', stage: pinned, stageIsScreen: false, others: withRest(pinned, false) };
  }

  // Alone in the meeting.
  if (participants.length === 1) {
    return { mode: 'alone', stage: participants[0]!, stageIsScreen: false, others: [] };
  }

  // 3/4. Two people: the other person fills the stage, we are the corner preview.
  if (participants.length === 2 && local && remotes[0]) {
    return { mode: 'pair', stage: remotes[0], stageIsScreen: false, others: [local] };
  }

  // 3. Active speaker: speaking right now, else the most recent remote speaker,
  //    else the first remote.
  const speakingNow = remotes.find((p) => p.speaking);
  const last = opts.lastSpokeAt ?? {};
  const recent = [...remotes].filter((p) => (last[p.identity] ?? 0) > 0).sort((a, b) => (last[b.identity] ?? 0) - (last[a.identity] ?? 0))[0];
  const stage = speakingNow ?? recent ?? remotes[0] ?? participants[0]!;
  return { mode: 'speaker', stage, stageIsScreen: false, others: withRest(stage, false) };
}

/** Remember when each remote last spoke; drops people who left. Returns the same
 *  object when nothing changed so React state does not churn. */
export function updateLastSpoke(prev: Readonly<Record<string, number>>, participants: readonly RoomParticipantView[], now: number): Record<string, number> {
  let changed = false;
  const next: Record<string, number> = {};
  const present = new Set(participants.map((p) => p.identity));
  for (const id of Object.keys(prev)) {
    if (present.has(id)) next[id] = prev[id]!;
    else changed = true;
  }
  for (const p of participants) {
    if (!p.isLocal && p.speaking) {
      next[p.identity] = now;
      changed = true;
    }
  }
  return changed ? next : (prev as Record<string, number>);
}

/** Columns for the thumbnail grid: 1 for one tile, 2 on a phone in portrait,
 *  more only where tiles would otherwise get tiny. */
export function gridColumns(count: number, width: number, landscape: boolean): number {
  if (count <= 1) return 1;
  if (landscape) return width >= 700 ? 3 : 2;
  return width >= 720 ? 3 : 2;
}

/** Tile size for a grid of `cols` columns in `width`, with a `gap`. */
export function tileSize(width: number, cols: number, gap: number, aspect = 0.8): { w: number; h: number } {
  const w = Math.floor((width - gap * (cols - 1)) / cols);
  return { w, h: Math.round(w / aspect) };
}

/** Heading text: "3 participants", "Only you", … */
export function participantCountLabel(n: number): string {
  if (n <= 1) return 'Only you';
  return `${n} participants`;
}

/** mm:ss or h:mm:ss for a meeting clock. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
