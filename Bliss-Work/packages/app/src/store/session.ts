import { create } from "zustand";
import type { UserDTO } from "@taskboard/shared";

interface SessionState {
  user: UserDTO | null;
  accessToken: string | null;
  status: "loading" | "authed" | "anon";
  /** Epoch ms when the current accessToken expires, derived here from the
   *  server-supplied `expiresIn` (seconds — login/MFA-verify/org-switch/
   *  refresh all return it) at the moment it's set. Used to schedule a
   *  proactive refresh before the token actually expires — see
   *  RuntimeProvider in lib/runtime.tsx. Stored as an absolute timestamp
   *  rather than the raw duration so every refresh produces a genuinely NEW
   *  value even when the TTL itself is unchanged (always ~900s) — a raw
   *  duration would leave React's effect dependency seeing the same number
   *  after every refresh and never re-arming. Null until a session carrying
   *  expiresIn has been set at least once. */
  expiresAt: number | null;
  setSession: (s: { user: UserDTO; accessToken: string; expiresIn: number }) => void;
  setToken: (t: string) => void;
  setUser: (user: UserDTO) => void;
  clear: () => void;
}

export const useSession = create<SessionState>((set) => ({
  user: null,
  accessToken: null,
  status: "loading",
  expiresAt: null,
  setSession: ({ user, accessToken, expiresIn }) =>
    set({ user, accessToken, expiresAt: Date.now() + expiresIn * 1000, status: "authed" }),
  setToken: (accessToken) => set({ accessToken }),
  setUser: (user) => set({ user }),
  clear: () => set({ user: null, accessToken: null, expiresAt: null, status: "anon" }),
}));
