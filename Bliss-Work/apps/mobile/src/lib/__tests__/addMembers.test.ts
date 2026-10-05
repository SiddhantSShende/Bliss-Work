import type { UserDTO } from '@taskboard/shared';
import { addMembersToCall, describeAddResult } from '../addMembers';

const u = (id: string, name: string) => ({ id, displayName: name }) as UserDTO;
const A = u('a', 'Rahul');
const B = u('b', 'Amit');
const C = u('c', 'Priya');

describe('addMembersToCall', () => {
  it('adds each new member once, in order', async () => {
    const calls: string[] = [];
    const r = await addMembersToCall(async (id) => void calls.push(id), [A, B], new Set());
    expect(calls).toEqual(['a', 'b']);
    expect(r.added).toEqual([A, B]);
    expect(r.failed).toEqual([]);
  });

  it('never duplicates: skips members already in and repeats in the selection', async () => {
    const add = jest.fn(async () => undefined);
    const r = await addMembersToCall(add, [A, B, B], new Set(['a']));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('b');
    expect(r.skipped.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('keeps going after a failure and reports it per person', async () => {
    const add = jest.fn(async (id: string) => {
      if (id === 'b') throw new Error('forbidden');
    });
    const r = await addMembersToCall(add, [A, B, C], new Set());
    expect(r.added.map((x) => x.id)).toEqual(['a', 'c']);
    expect(r.failed).toEqual([{ user: B, message: 'forbidden' }]);
  });
});

describe('describeAddResult', () => {
  it('describes success, partial and total failure', () => {
    expect(describeAddResult({ added: [A], skipped: [], failed: [] }).title).toBe('Rahul added');
    expect(describeAddResult({ added: [A, B], skipped: [], failed: [] }).title).toBe('2 members added');
    expect(describeAddResult({ added: [A], skipped: [], failed: [{ user: B, message: 'x' }] }).title).toBe('Added 1, 1 failed');
    expect(describeAddResult({ added: [], skipped: [], failed: [{ user: B, message: 'x' }] }).title).toBe("Couldn't add members");
    expect(describeAddResult({ added: [], skipped: [A], failed: [] }).title).toBe('Nobody new to add');
  });
});
