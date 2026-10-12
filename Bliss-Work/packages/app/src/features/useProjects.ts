import { useQuery } from "@tanstack/react-query";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

export function useProjects() {
  const { api } = useRuntime();
  return useQuery({
    queryKey: qk.projects,
    queryFn: () => api.projects(),
    staleTime: 60_000,
  });
}
