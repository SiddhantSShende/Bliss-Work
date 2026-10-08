import type { CallDTO } from '@taskboard/shared';
import type { CallMedia } from './callController';
import type { CallLink } from './callLinks';

/**
 * Joining a call from a LINK (a `blisswork://call/<id>` deep link, a web call
 * URL, or an invite token). The user did not choose to open it — anyone can send
 * one — so nothing is joined until they confirm, and the join starts with the
 * microphone and camera OFF. Without this a crafted link put the victim live on
 * camera the moment it was opened.
 *
 * Kept free of React/native imports (everything is injected) so the ordering —
 * confirm FIRST, only then redeem the token / ask for a room token / connect —
 * is unit-tested. Redeeming an invite token is itself a join (the server adds
 * the user to the call), so it must not happen before the confirmation either.
 */
export interface LinkJoinDeps {
  /** Ask the user; resolves true only on an explicit "Join". */
  confirm: () => Promise<boolean>;
  /** Exchange an invite token for its call (server-side join). */
  redeemToken: (token: string) => Promise<Pick<CallDTO, 'id' | 'media' | 'title'>>;
  /** Enter the call. Always invoked with `startMuted: true`. */
  join: (callId: string, media: CallMedia, title: string | undefined, opts: { startMuted: true }) => void;
  redeemFailed: () => void;
}

export async function joinFromCallLink(link: CallLink, d: LinkJoinDeps): Promise<void> {
  if (!(await d.confirm())) return;
  if (link.kind === 'call') {
    d.join(link.callId, 'video', undefined, { startMuted: true });
    return;
  }
  let call: Pick<CallDTO, 'id' | 'media' | 'title'>;
  try {
    call = await d.redeemToken(link.token);
  } catch {
    d.redeemFailed();
    return;
  }
  d.join(call.id, call.media, call.title || undefined, { startMuted: true });
}
