import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";

/** The shape both MessageDTO and ChannelMessageDTO share for reconciling a
 *  temp row against the server's response. Mirrors useOlderMessages' `Paged`
 *  — same two fields, different purpose (identity tracking here, not
 *  paging), so it is kept as its own small type rather than imported. */
interface Sendable {
  id: string;
  seq: number;
}

/** What every surface's compose bar hands the mutation: the text and,
 *  optionally, the message being quoted. */
export interface SendVars {
  body: string;
  replyToId?: string;
}

/** What a successful send returns, per DMView's `api.reply` and ChannelView's
 *  `api.sendChannelMessage` — both resolve `{ messageId, seq }`. */
export interface OptimisticSendResult {
  messageId: string;
  seq: number;
}

export interface UseOptimisticSendOptions<TDto extends Sendable> {
  /** The flat message-list query this mutation reads and patches. */
  queryKey: QueryKey;
  /** Builds the row appended to the list the instant Send is pressed, before
   *  the server has heard of it. Receives the minted `temp:` id, the vars the
   *  caller sent, and the list as it stood before this send — callers use the
   *  last argument to compute the optimistic `seq` the same way the real list
   *  will once the 201 lands. */
  buildOptimistic: (tempId: string, vars: SendVars, prev: TDto[]) => TDto;
  mutationFn: (vars: SendVars) => Promise<OptimisticSendResult>;
  /**
   * Applied on top of the `{ id, seq }` patch every reconciled row gets, for
   * whatever a surface needs beyond that off the 201 — e.g. DMView's
   * `status: "SENT"` (channel messages carry no `status` field at all: see
   * ChannelMessageDTO). Omit it to get the plain id/seq patch, which is all
   * ChannelView needs.
   */
  reconcile?: (dto: TDto, res: OptimisticSendResult) => TDto;
  /** Extra work once the temp row has been reconciled — DMView and
   *  ChannelView each invalidate a different "list" query here (conversations
   *  vs. channels) to refresh their own last-message preview. */
  onSuccess?: (res: OptimisticSendResult, vars: SendVars) => void;
  /** Extra work after the rollback + error toast below have already run. */
  onError?: (error: unknown, vars: SendVars) => void;
}

/**
 * Optimistic send, shared by every surface with a compose bar.
 *
 * DMView and ChannelView each hand-rolled the same mutation: cancel in-flight
 * queries for the thread → read the current list → mint a `temp:` id → append
 * an optimistic row → on success swap the temp id for the server's real
 * id/seq → on error drop the temp row and toast. Rather than implement that
 * state machine twice (and re-diverge the next time one of them changes it),
 * it lives here — the same reasoning as useChatMedia consolidating
 * attachments instead of forking them across DM/Channel/Mail.
 *
 * What varies per surface — the query key, the DTO's exact shape, the send
 * call itself, and DMView's sender-side `status` field — is supplied by the
 * caller rather than guessed at here.
 */
export function useOptimisticSend<TDto extends Sendable>({
  queryKey,
  buildOptimistic,
  mutationFn,
  reconcile,
  onSuccess,
  onError,
}: UseOptimisticSendOptions<TDto>) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn,
    onMutate: async (vars: SendVars) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<TDto[]>(queryKey) ?? [];
      const tempId = `temp:${crypto.randomUUID()}`;
      qc.setQueryData<TDto[]>(queryKey, [...prev, buildOptimistic(tempId, vars, prev)]);
      return { tempId };
    },
    onSuccess: (res, vars, ctx) => {
      qc.setQueryData<TDto[]>(queryKey, (prev) =>
        (prev ?? []).map((m) => {
          if (m.id !== ctx?.tempId) return m;
          const patched: TDto = { ...m, id: res.messageId, seq: res.seq };
          return reconcile ? reconcile(patched, res) : patched;
        }),
      );
      onSuccess?.(res, vars);
    },
    onError: (error, vars, ctx) => {
      qc.setQueryData<TDto[]>(queryKey, (prev) => (prev ?? []).filter((m) => m.id !== ctx?.tempId));
      toast.error("Message failed to send");
      onError?.(error, vars);
    },
  });
}
