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
