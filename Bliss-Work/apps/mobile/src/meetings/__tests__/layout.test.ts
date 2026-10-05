import type { RoomParticipantView } from '../../calls/roomController';
import { formatElapsed, gridColumns, participantCountLabel, pickStage, tileSize, updateLastSpoke } from '../layout';

const P = (id: string, o: Partial<RoomParticipantView> = {}): RoomParticipantView => ({ identity: id, name: id, isLocal: id === 'me', speaking: false, micOn: true, camOn: false, ...o });

describe('pickStage', () => {
  it('alone: you on the stage, nothing else', () => {
    const p = pickStage([P('me')]);
    expect(p.mode).toBe('alone');
    expect(p.stage?.identity).toBe('me');
    expect(p.others).toEqual([]);
  });

  it('two people: the other person on stage, you as the corner preview', () => {
    const p = pickStage([P('me'), P('bob')]);
    expect(p.mode).toBe('pair');
    expect(p.stage?.identity).toBe('bob');
    expect(p.others.map((x) => x.identity)).toEqual(['me']);
  });

  it('many people: the person speaking now takes the stage, you are last', () => {
    const p = pickStage([P('me'), P('a'), P('b', { speaking: true }), P('c')]);
    expect(p.mode).toBe('speaker');
    expect(p.stage?.identity).toBe('b');
    expect(p.others.map((x) => x.identity)).toEqual(['a', 'c', 'me']);
  });

  it('nobody speaking: the most recent speaker stays, else the first remote', () => {
    const list = [P('me'), P('a'), P('b'), P('c')];
    expect(pickStage(list, { lastSpokeAt: { a: 10, c: 50, b: 20 } }).stage?.identity).toBe('c');
    expect(pickStage(list).stage?.identity).toBe('a');
  });

  it('a shared screen outranks everything and keeps the sharer as a thumbnail', () => {
    const list = [P('me'), P('a', { speaking: true }), P('b', { sharing: true, screenRef: {} })];
    const p = pickStage(list, { pinned: 'a' });
    expect(p.mode).toBe('share');
    expect(p.stageIsScreen).toBe(true);
    expect(p.stage?.identity).toBe('b');
    expect(p.others.map((x) => x.identity)).toEqual(['b', 'a', 'me']);
  });

  it('our own shared screen is never put on our own stage', () => {
    const p = pickStage([P('me', { sharing: true, screenRef: {} }), P('a'), P('b')]);
    expect(p.mode).toBe('speaker');
    expect(p.stageIsScreen).toBe(false);
  });

  it('a sharing flag without a track is not enough to take the stage', () => {
    expect(pickStage([P('me'), P('a', { sharing: true }), P('b')]).mode).toBe('speaker');
  });

  it('pinned wins over the speaker, but only while that person is still there', () => {
    const list = [P('me'), P('a'), P('b', { speaking: true })];
    expect(pickStage(list, { pinned: 'a' })).toMatchObject({ mode: 'pinned', stage: { identity: 'a' } });
    expect(pickStage(list, { pinned: 'gone' }).mode).toBe('speaker');
  });

  it('nobody in the room yields an empty stage rather than crashing', () => {
    expect(pickStage([]).stage).toBeNull();
  });
});

describe('updateLastSpoke', () => {
  it('records remote speakers, forgets people who left, and keeps identity when unchanged', () => {
    const list = [P('me', { speaking: true }), P('a', { speaking: true }), P('b')];
    const t1 = updateLastSpoke({}, list, 100);
    expect(t1).toEqual({ a: 100 });
    const quiet = [P('me'), P('a'), P('b')];
    expect(updateLastSpoke(t1, quiet, 200)).toBe(t1);
    expect(updateLastSpoke(t1, [P('me'), P('b')], 300)).toEqual({});
  });
});

describe('grid sizing', () => {
  it('uses 1 column for one tile and 2 on phones, 3 on wide screens', () => {
    expect(gridColumns(1, 360, false)).toBe(1);
    expect(gridColumns(4, 360, false)).toBe(2);
    expect(gridColumns(4, 800, false)).toBe(3);
    expect(gridColumns(4, 640, true)).toBe(2);
    expect(gridColumns(4, 900, true)).toBe(3);
  });

  it('fits the tiles inside the width on the smallest phones', () => {
    for (const width of [320, 360, 412, 600]) {
      for (const cols of [1, 2, 3]) {
        const { w } = tileSize(width - 32, cols, 8);
        expect(w * cols + 8 * (cols - 1)).toBeLessThanOrEqual(width - 32);
      }
    }
  });
});

describe('labels', () => {
  it('formats the meeting clock and participant count', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(754_000)).toBe('12:34');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('00:00');
    expect(participantCountLabel(1)).toBe('Only you');
    expect(participantCountLabel(8)).toBe('8 participants');
  });
});
