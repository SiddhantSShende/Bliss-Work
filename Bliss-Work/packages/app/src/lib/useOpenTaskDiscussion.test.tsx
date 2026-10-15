import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const openTaskDiscussion = vi.fn();
const openSelfChat = vi.fn();
const openChat = vi.fn();
let navigateSpy: ReturnType<typeof vi.fn>;

vi.mock("./runtime", () => ({
  useRuntime: () => ({ api: { openTaskDiscussion, openSelfChat } }),
}));
vi.mock("./selectedChat", () => ({
  useSelectedChat: () => ({ openChat }),
}));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: "me" } }),
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateSpy };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { useOpenTaskDiscussion } from "./useOpenTaskDiscussion";

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  openTaskDiscussion.mockReset();
  openSelfChat.mockReset();
  openChat.mockReset();
  navigateSpy = vi.fn();
});

describe("useOpenTaskDiscussion", () => {
  it("opens the DM via useSelectedChat, carrying the taskId, never the URL", async () => {
    openTaskDiscussion.mockResolvedValue({ id: "d1", taskId: "t1", kind: "DM", conversationId: "c1" });
    const { result } = renderHook(() => useOpenTaskDiscussion(), { wrapper });

    await result.current.openDiscussion({ taskId: "t1", peerId: "p1" });

    expect(openTaskDiscussion).toHaveBeenCalledWith("t1", { peerId: "p1" });
    expect(openChat).toHaveBeenCalledWith("c1", { taskId: "t1" });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("opens the caller's own self-chat instead of a task discussion when peerId is the caller, still carrying the taskId", async () => {
    openSelfChat.mockResolvedValue({ conversationId: "self-c1" });
    const { result } = renderHook(() => useOpenTaskDiscussion(), { wrapper });

    await result.current.openDiscussion({ taskId: "t1", peerId: "me" });

    expect(openTaskDiscussion).not.toHaveBeenCalled();
    expect(openSelfChat).toHaveBeenCalledTimes(1);
    // Regression: the taskId must be passed through here too, or focusTaskId
    // never gets set for a self-assigned task's chat, and DMView's composer
    // silently falls back to the plain (untagged) reply for every message —
    // the self-assigned task never gets its "Task: …" card in chat.
    expect(openChat).toHaveBeenCalledWith("self-c1", { taskId: "t1" });
  });

  it("navigates to the channel with ?taskId= for the channel case", async () => {
    openTaskDiscussion.mockResolvedValue({ id: "d2", taskId: "t2", kind: "CHANNEL", channelId: "ch1" });
    const { result } = renderHook(() => useOpenTaskDiscussion(), { wrapper });

    await result.current.openDiscussion({ taskId: "t2", channelId: "ch1" });

    expect(openTaskDiscussion).toHaveBeenCalledWith("t2", { channelId: "ch1" });
    expect(navigateSpy).toHaveBeenCalledWith("/app/channels/ch1?taskId=t2");
    expect(openChat).not.toHaveBeenCalled();
  });

  it("does nothing when both or neither target is given", async () => {
    const { result } = renderHook(() => useOpenTaskDiscussion(), { wrapper });

    await result.current.openDiscussion({ taskId: "t3" });
    await result.current.openDiscussion({ taskId: "t3", peerId: "p1", channelId: "ch1" });

    expect(openTaskDiscussion).not.toHaveBeenCalled();
  });

  it("toasts on failure and does not throw", async () => {
    openTaskDiscussion.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useOpenTaskDiscussion(), { wrapper });

    await expect(result.current.openDiscussion({ taskId: "t4", peerId: "p1" })).resolves.toBeUndefined();
    await waitFor(() => expect(openChat).not.toHaveBeenCalled());
  });
});
