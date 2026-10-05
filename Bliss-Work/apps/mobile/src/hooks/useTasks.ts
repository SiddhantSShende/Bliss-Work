import { Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { errorText } from '@taskboard/app/lib/errorText';
import { qk } from './queryKeys';

/** Tasks assigned to me (mine/available/completed buckets are derived
 *  client-side from `myStatus`) plus tasks I sent. */
export function useTasks() {
  const { api } = useRuntime();
  const assigned = useQuery({ queryKey: qk.tasksAssigned, queryFn: () => api.taskAssigned() });
  const sent = useQuery({ queryKey: qk.tasksSent, queryFn: () => api.tasksSent() });
  return { assigned, sent };
}

export function useTaskDetail(taskId: string | undefined) {
  const { api } = useRuntime();
  return useQuery({
    queryKey: qk.taskDetail(taskId ?? ''),
    queryFn: () => api.taskDetail(taskId!),
    enabled: Boolean(taskId),
  });
}

/** Acknowledge/complete/ignore/leave one of my task assignments — server
 *  handles idempotency (`ApiClient.taskAction` mints its own key). */
export function useTaskAction() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, action }: { taskId: string; action: 'acknowledge' | 'complete' | 'ignore' | 'leave' }) =>
      api.taskAction(taskId, action),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasksAssigned });
      void qc.invalidateQueries({ queryKey: qk.tasksSent });
    },
    onError: (e) => {
      Alert.alert("Couldn't update task", errorText(e));
    },
  });
}

/** Assign a new task to one or more people — same `api.createTask` web's
 *  CreateTaskDialog uses in its "People" mode (channel-mode assignment isn't
 *  part of this screen's spec). */
export function useCreateTask() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ title, description, assigneeIds }: { title: string; description: string; assigneeIds: string[] }) =>
      api.createTask({ title, description, assigneeIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasksSent });
    },
  });
}
