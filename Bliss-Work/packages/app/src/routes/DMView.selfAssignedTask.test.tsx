/**
 * Regression for the self-assigned-task chat-metadata bug: a self-assigned
 * task's "Chat" button opens the caller's own Notes-to-Self conversation
 * (see useOpenTaskDiscussion.ts), which previously dropped the taskId it was
 * opened for. With focusTaskId never set, every message typed there went
 * through the plain untagged `reply` — never `taskId`-tagged — so
 * ChatThread's "Task: {title}" card (ChatThread.taskCard.test.tsx /
 * ChatThread.taskLabel.test.tsx) never appeared for a self-assigned task,
 * even though the exact same flow works for a task assigned to someone else
 * (api.sendTaskDiscussionMessage, covered by the composer send path there).
 *
 * This mounts the real DMView, following the same minimal mocking shape as
 * DMView.selfChat.test.tsx, but with useSelectedChat reporting a focusTaskId
 * — exactly what a self-assigned task's "Chat" button now sets.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const TASK_ID = "11111111-1111-1111-1111-111111111111";

const h = vi.hoisted(() => ({
  conversation: { id: "cv-1", peerId: "me", peerUsername: "me", peerDisplayName: "Me" } as unknown,
  messages: [] as unknown[],
}));

const shareTaskToSelfChat = vi.fn();
const sendTaskDiscussionMessage = vi.fn();
const reply = vi.fn();

const stub = (name: string) => {
  switch (name) {
    case "conversations": return async () => [h.conversation];
    case "messages": return async () => h.messages;
    case "shareTaskToSelfChat": return shareTaskToSelfChat;
    case "sendTaskDiscussionMessage": return sendTaskDiscussionMessage;
    case "reply": return reply;
    default: return async () => [];
  }
};
const api = new Proxy({}, { get: (_t, name: string) => stub(name) });
const rtc = new Proxy({}, { get: (_t, name: string) => (name.startsWith("on") ? () => () => {} : vi.fn()) });

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, rtc, config: { kind: "web" } }) }));
vi.mock("../store/session", () => {
  const user = { id: "me", username: "me", displayName: "Me", roles: [] as string[] };
  const state = { user, status: "authed" };
  const useSession = (sel: (s: typeof state) => unknown) => sel(state);
  useSession.getState = () => state;
  return { useSession };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({ stateOf: () => undefined, decline: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), session: null, active: false }),
}));
vi.mock("../lib/useCall", () => ({ useCall: () => new Proxy({}, { get: () => vi.fn() }) }));
vi.mock("../lib/selectedChat", () => ({
  // The exact shape useOpenTaskDiscussion's self-chat branch now produces:
  // openChat(conversationId, { taskId }) sets focusTaskId.
  useSelectedChat: () => ({ selectedId: "cv-1", closeChat: vi.fn(), openChat: vi.fn(), focusTaskId: TASK_ID, clearTaskFocus: vi.fn() }),
}));

import { DMView } from "./DMView";

function mount() {
  Element.prototype.scrollTo = vi.fn();
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/chats/cv-1"]}>
        <Routes>
          <Route path="/chats/:conversationId" element={<DMView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DMView: self-assigned task's Chat button (Notes to Self, task-focused)", () => {
  it("sends through shareTaskToSelfChat, tagged with taskId, never the plain reply or sendTaskDiscussionMessage", async () => {
    shareTaskToSelfChat.mockResolvedValue({ conversationId: "cv-1", threadId: "th-1", messageId: "m-1", seq: 1 });
    const user = userEvent.setup();
    mount();

    const box = await screen.findByPlaceholderText("Write a note to yourself…");
    await user.type(box, "ppp status update{Enter}");

    expect(shareTaskToSelfChat).toHaveBeenCalledWith(TASK_ID, "ppp status update", undefined, undefined);
    expect(sendTaskDiscussionMessage).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();

    // The optimistic row is tagged immediately (ChatThread.taskLabel.test.tsx
    // proves taskId alone is enough to render the card), so the task
    // reference shows up without waiting on the mocked send to resolve.
    expect(await screen.findByRole("link", { name: new RegExp(`Task: ${TASK_ID}`) })).toBeTruthy();
  });
});
