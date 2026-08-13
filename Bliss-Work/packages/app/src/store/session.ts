import { create } from "zustand";
import type { UserDTO } from "@taskboard/shared";

interface SessionState {
  user: UserDTO | null;
  accessToken: string | null;
  status: "loading" | "authed" | "anon";
  setSession: (s: { user: UserDTO; accessToken: string }) => void;
  setToken: (t: string) => void;
  setUser: (user: UserDTO) => void;
  clear: () => void;
}

export const useSession = create<SessionState>((set) => ({
  user: null,
  accessToken: null,
  status: "loading",
  setSession: ({ user, accessToken }) => set({ user, accessToken, status: "authed" }),
  setToken: (accessToken) => set({ accessToken }),
  setUser: (user) => set({ user }),
  clear: () => set({ user: null, accessToken: null, status: "anon" }),
}));
