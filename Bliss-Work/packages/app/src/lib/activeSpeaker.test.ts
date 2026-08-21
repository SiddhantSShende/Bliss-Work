import { describe, expect, it } from "vitest";
import {
  DEMOTE_AFTER_MS,
  PROMOTE_AFTER_MS,
  initialSpeakerState,
  pruneSpeakers,
  reduceActiveSpeaker,
  type SpeakerState,
} from "./activeSpeaker";

/** Play a script of [elapsed-ms, who-is-speaking] samples through the filter. */
function play(script: ReadonlyArray<readonly [number, string[]]>): SpeakerState {
  let state = initialSpeakerState;
  for (const [at, speaking] of script) {
    state = reduceActiveSpeaker(state, speaking, at);
  }
  return state;
}

describe("taking the stage", () => {
  it("stays empty until someone has actually held the floor", () => {
    const state = play([
      [0, ["alice"]],
      [PROMOTE_AFTER_MS - 1, ["alice"]],
    ]);
    expect(state.active).toBeNull();
  });

  it("promotes a voice that sustains", () => {
    const state = play([
      [0, ["alice"]],
      [PROMOTE_AFTER_MS, ["alice"]],
    ]);
    expect(state.active).toBe("alice");
  });

  it("ignores a cough — the whole reason this filter exists", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]], // alice has the stage
      [700, ["alice", "bob"]], // bob coughs
      [850, ["alice"]], // ...and stops, 150ms later
      [900, ["alice"]],
    ]);
    expect(state.active).toBe("alice");
  });

  it("does not let a stop/start accumulate credit toward promotion", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]],
      // bob speaks in 300ms bursts — never a contiguous 500ms run.
      [1000, ["bob"]],
      [1300, []],
      [1400, ["bob"]],
      [1700, []],
      [1800, ["bob"]],
      [2100, []],
    ]);
    expect(state.active).toBe("alice");
  });
});

describe("keeping the stage", () => {
  it("survives a pause shorter than the handover window", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]], // alice on stage
      [1000, []], // alice draws breath
      [1000 + DEMOTE_AFTER_MS - 1, []], // still silent, 1ms short of the window
    ]);
    expect(state.active).toBe("alice");
  });

  it("hands over once the pause is long enough AND the newcomer sustains", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]],
      [1000, []], // alice stops
      [1000 + DEMOTE_AFTER_MS + 10, ["bob"]], // bob starts after the window
      [1000 + DEMOTE_AFTER_MS + 10 + PROMOTE_AFTER_MS, ["bob"]],
    ]);
    expect(state.active).toBe("bob");
  });

  it("cannot be interrupted while the holder is still talking", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]],
      // bob talks over alice for a long time; alice never stops.
      [1000, ["alice", "bob"]],
      [30_000, ["alice", "bob"]],
    ]);
    expect(state.active).toBe("alice");
  });
});

describe("silence timeout", () => {
  it("releases the stage once silence has run past the handover window with nobody taking over", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]], // alice on stage
      [2000, []], // alice falls silent
      [2000 + DEMOTE_AFTER_MS + 1, []], // the room stays quiet past the window
    ]);
    expect(state.active).toBeNull();
  });

  it("expires purely from elapsed time — the reducer is re-invoked with the SAME (empty) speaking set both times, only the clock advances", () => {
    let state = play([
      [0, ["alice"]],
      [600, ["alice"]],
      [2000, []], // alice falls silent
    ]);
    state = reduceActiveSpeaker(state, [], 2000 + DEMOTE_AFTER_MS - 1);
    expect(state.active).toBe("alice"); // not yet past the window

    state = reduceActiveSpeaker(state, [], 2000 + DEMOTE_AFTER_MS + 1);
    expect(state.active).toBeNull(); // same [] passed both times — only `now` moved
  });

  it("never promotes an empty room — no speaker, no stage", () => {
    const state = reduceActiveSpeaker(initialSpeakerState, [], 0);
    expect(state.active).toBeNull();
  });
});

describe("two people starting together", () => {
  it("gives it to whoever actually began first", () => {
    const state = play([
      [0, ["bob"]],
      [100, ["alice", "bob"]],
      [700, ["alice", "bob"]],
    ]);
    expect(state.active).toBe("bob");
  });
});

describe("pruneSpeakers", () => {
  it("clears the stage when the person on it leaves", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]],
    ]);
    expect(pruneSpeakers(state, new Set(["bob"])).active).toBeNull();
  });

  it("keeps the stage when someone else leaves", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]],
    ]);
    expect(pruneSpeakers(state, new Set(["alice", "carol"])).active).toBe("alice");
  });

  it("returns the same object when nothing changed, so it is safe as a guard", () => {
    const state = play([
      [0, ["alice"]],
      [600, ["alice"]],
    ]);
    expect(pruneSpeakers(state, new Set(["alice"]))).toBe(state);
  });

  it("forgets the runs of people who left", () => {
    const state = play([
      [0, ["alice", "bob"]],
      [600, ["alice", "bob"]],
    ]);
    const pruned = pruneSpeakers(state, new Set(["alice"]));
    expect(Object.keys(pruned.startedAt)).toEqual(["alice"]);
  });
});
