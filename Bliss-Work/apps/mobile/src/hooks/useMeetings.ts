import { Alert } from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CallDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { errorText } from '@taskboard/app/lib/errorText';
import { useCalls } from '../calls/CallProvider';
import { qk } from './queryKeys';

/** Upcoming (`myCalls`, capped ~1 month out) and past (`myCallHistory`,
 *  first page) meetings. */
export function useMeetings() {
  const { api } = useRuntime();
  const upcoming = useQuery({ queryKey: qk.myCalls, queryFn: () => api.myCalls() });
  const history = useQuery({ queryKey: qk.callHistory, queryFn: () => api.myCallHistory() });
  return { upcoming, history };
}

/** Full finished-meeting history, paged by the server's cursor. Lives under the
 *  `callHistory` prefix so a `CallEnded` invalidation refreshes it too. */
export function useCallHistoryAll() {
  const { api } = useRuntime();
  return useInfiniteQuery({
    queryKey: [...qk.callHistory, 'all'] as const,
    queryFn: ({ pageParam }) => api.myCallHistory(pageParam, 10),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** "Join" enters the meeting's room inside the app (LiveKit, same room web
 *  uses via `/calls/:id/token`) — the in-app call screen, never a browser. */
export function useJoinMeeting() {
  const { joinMeeting } = useCalls();
  return (call: Pick<CallDTO, 'id' | 'media' | 'title'>) => joinMeeting(call.id, call.media, call.title || undefined);
}

/** Every meeting overlapping [from, to) — the calendar read web's
 *  MeetingsCalendar uses. Kept per-window so paging months reuses the cache. */
export function useMeetingsInRange(from: Date, to: Date) {
  const { api } = useRuntime();
  const fromISO = from.toISOString();
  const toISO = to.toISOString();
  return useQuery({
    queryKey: qk.callsRange(fromISO, toISO),
    queryFn: () => api.myCallsInRange(fromISO, toISO),
  });
}

export function useScheduleMeeting() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title?: string;
      media?: 'audio' | 'video';
      scheduledAt?: string;
      durationMinutes?: number;
      inviteeIds?: string[];
    }) => api.scheduleMeeting(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.myCalls });
      void qc.invalidateQueries({ queryKey: qk.callsRangePrefix });
    },
    onError: (e) => {
      Alert.alert("Couldn't schedule meeting", errorText(e));
    },
  });
}

/** "Send Call Link" from a chat header: opens a meeting with the peer
 *  already on its roster (so it also shows up under their Meetings, not
 *  only as a URL) and mints a one-time join token — same shape as web's
 *  `deliverCallLink` (packages/app/src/lib/deliverCallLink.ts), just without
 *  its multi-recipient fan-out, which the mobile menu doesn't offer. The
 *  caller posts the returned link into the conversation itself. */
export function useSendCallLink() {
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ peerId, peerName }: { peerId: string; peerName: string }) => {
      const call = await api.scheduleMeeting({ title: `Call with ${peerName}`, media: 'video', inviteeIds: [peerId] });
      const invite = await api.createCallInvite(call.id);
      return `${config.webBaseUrl}/join?t=${encodeURIComponent(invite.token)}`;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.myCalls });
      void qc.invalidateQueries({ queryKey: qk.callsRangePrefix });
    },
    onError: () => {
      Alert.alert("Couldn't create call link", 'Please try again.');
    },
  });
}
