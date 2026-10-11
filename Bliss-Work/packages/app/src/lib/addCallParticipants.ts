/**
 * Add several people to a call, one request each, and keep going when one is
 * refused.
 *
 * One at a time because the server checks each add against the call as it then
 * stands (blocks, the participant limit), so the order is the only fair
 * answer to "who made it in". Not all-or-nothing: the people who were added have
 * already been rung and are on their way, so stopping at the first refusal would
 * leave them calling into a room the caller believes nobody joined.
 */
export interface AddOutcome {
  added: string[];
  failed: { userId: string; error: unknown }[];
}

export async function addCallParticipants(
  add: (userId: string) => Promise<unknown>,
  userIds: readonly string[],
): Promise<AddOutcome> {
  const added: string[] = [];
  const failed: AddOutcome["failed"] = [];
  for (const userId of userIds) {
    try {
      await add(userId);
      added.push(userId);
    } catch (error) {
      failed.push({ userId, error });
    }
  }
  return { added, failed };
}
