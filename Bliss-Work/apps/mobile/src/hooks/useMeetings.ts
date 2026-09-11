import { Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/** Upcoming (`myCalls`, capped ~1 month out) and past (`myCallHistory`,
 *  first page) meetings — the list-only surface confirmed for mobile; no
 *  calendar grid (that's web's `MeetingsCalendar.tsx`, out of scope here). */
export function useMeetings() {
  const { api } = useRuntime();
  const upcoming = useQuery({ queryKey: qk.myCalls, queryFn: () => api.myCalls() });
  const history = useQuery({ queryKey: qk.callHistory, queryFn: () => api.myCallHistory() });
  return { upcoming, history };
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
    },
    onError: () => {
      Alert.alert("Couldn't schedule meeting", 'Please try again.');
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
    },
    onError: () => {
      Alert.alert("Couldn't create call link", 'Please try again.');
    },
  });
}
