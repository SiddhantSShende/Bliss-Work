/**
 * The chat selection, and the one thing it exists to guarantee: a conversation
 * id never reaches the URL.
 *
 * `/app/chats/:conversationId` used to put a private conversation's UUID in the
 * address bar, in every history entry, and in the referrer of anything the page
 * links out to. It is now held in memory instead, which changes four behaviours
 * that all used to be the router's job — opening a chat, switching between
 * chats, Back, and what a reload lands on. Each is asserted here, because none
 * of them is visible in the type system and all four are one refactor away from
 * silently regressing.
 *
 * Driven through a real MemoryRouter and real components rather than by poking
 * the hook: "what does the URL say" is not a question the hook can answer.
 */
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { CHATS_PATH, SelectedChatProvider, useSelectedChat } from "./selectedChat";

const ALICE = "019ff9db-8c07-7c6c-8fa2-882db497b4d2";
const BOB = "019ff9db-8c07-7c6c-8fa2-882db497b4d3";

/** The address bar, as the test can read it. */
function UrlProbe() {
  const loc = useLocation();
  return <div data-testid="url">{`${loc.pathname}${loc.search}`}</div>;
}

/** Stands in for ChatsList: rows that select, and nothing else. */
function List() {
  const { openChat } = useSelectedChat();
  return (
    <>
      <button type="button" onClick={() => openChat(ALICE)}>
        open alice
      </button>
      <button type="button" onClick={() => openChat(BOB)}>
        open bob
      </button>
    </>
  );
}

/** Stands in for ChatsPane: the open conversation, or the neutral state. */
function Pane() {
  const { selectedId, closeChat } = useSelectedChat();
  if (!selectedId) return <div data-testid="empty">Pick a chat</div>;
  return (
    <div>
      <div data-testid="open-chat">{selectedId}</div>
      <button type="button" onClick={closeChat}>
        back to chats
      </button>
    </div>
  );
}

/** Stands in for ChatDeepLink: opens the id in the path, then erases it. */
function DeepLink() {
  const { conversationId = "" } = useParams();
  const { openChat } = useSelectedChat();
  // Mirrors App.tsx: select and replace, so the entry carrying the id is gone
  // from history rather than one Back press away.
  useEffect(() => {
    if (conversationId) openChat(conversationId, { replace: true });
  }, [conversationId, openChat]);
  return <div data-testid="empty">Pick a chat</div>;
}

function App({ initial = [CHATS_PATH] }: { initial?: string[] }) {
  return (
    <MemoryRouter initialEntries={initial}>
      <SelectedChatProvider>
        <UrlProbe />
        <List />
        <BackButton />
        <Routes>
          <Route path="/app/chats" element={<Pane />} />
          <Route path="/app/chats/:conversationId" element={<DeepLink />} />
          <Route path="/app/mail" element={<div data-testid="mail">Mail</div>} />
        </Routes>
      </SelectedChatProvider>
    </MemoryRouter>
  );
}

/**
 * The browser's Back button.
 *
 * MemoryRouter keeps its own stack and never touches window.history, so
 * window.history.back() would be a no-op here. navigate(-1) is the same delta
 * the real Back button produces, and React Router reports it as a POP either
 * way — which is the signal the provider is actually keyed on.
 */
function BackButton() {
  const nav = useNavigate();
  return (
    <button type="button" onClick={() => nav(-1)}>
      browser back
    </button>
  );
}

const url = () => screen.getByTestId("url").textContent;

describe("chat selection stays out of the URL", () => {
  it("opens a chat without putting its id in the path", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "open alice" }));

    expect(screen.getByTestId("open-chat")).toHaveTextContent(ALICE);
    expect(url()).toBe(CHATS_PATH);
    expect(url()).not.toContain(ALICE);
  });

  it("switches between chats without the URL ever changing", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "open alice" }));
    await user.click(screen.getByRole("button", { name: "open bob" }));

    expect(screen.getByTestId("open-chat")).toHaveTextContent(BOB);
    expect(url()).toBe(CHATS_PATH);
    expect(url()).not.toContain(ALICE);
    expect(url()).not.toContain(BOB);
  });

  it("shows the neutral empty state when nothing is selected", () => {
    render(<App />);
    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(screen.queryByTestId("open-chat")).not.toBeInTheDocument();
  });

  // A fresh mount IS a reload: the provider's state starts empty, so there is
  // nothing to restore. That is the intended behaviour and not a gap — the
  // alternative would be persisting the id somewhere durable, which is the
  // thing this whole module exists to avoid.
  it("lands on the chat list after a reload rather than reopening a chat", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await user.click(screen.getByRole("button", { name: "open alice" }));
    expect(screen.getByTestId("open-chat")).toHaveTextContent(ALICE);
    unmount();

    render(<App />);
    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(url()).toBe(CHATS_PATH);
  });

  it("closes the chat and returns to the list on the in-app back control", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "open alice" }));

    await user.click(screen.getByRole("button", { name: "back to chats" }));

    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(url()).toBe(CHATS_PATH);
  });
});

describe("the browser Back button", () => {
  // Opening a chat pushes one entry, so Back has something to pop; the provider
  // treats that POP as "close the chat". Without it, Back from an open chat
  // would leave the section entirely — the behaviour the URL used to give free.
  it("returns to the list from an open chat", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "open alice" }));
    expect(screen.getByTestId("open-chat")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "browser back" }));

    expect(await screen.findByTestId("empty")).toBeInTheDocument();
    expect(url()).toBe(CHATS_PATH);
  });

  // Switching chats REPLACES rather than pushes, so Back is one press from the
  // list however many chats were visited — not a walk back through each.
  it("does not stack an entry per chat visited", async () => {
    const user = userEvent.setup();
    render(<App initial={["/app/mail", CHATS_PATH]} />);
    await user.click(screen.getByRole("button", { name: "open alice" }));
    await user.click(screen.getByRole("button", { name: "open bob" }));

    await user.click(screen.getByRole("button", { name: "browser back" }));
    expect(await screen.findByTestId("empty")).toBeInTheDocument();

    // One more press leaves the section, which is where the user came from.
    await user.click(screen.getByRole("button", { name: "browser back" }));
    expect(await screen.findByTestId("mail")).toBeInTheDocument();
  });
});

describe("a /app/chats/:conversationId deep link", () => {
  // Bookmarks, notification targets and pasted links minted before the id came
  // out of the URL still have to work — and must not leave the id behind.
  it("opens the chat and replaces the id out of the URL", async () => {
    render(<App initial={[`${CHATS_PATH}/${ALICE}`]} />);

    await screen.findByTestId("open-chat");
    expect(screen.getByTestId("open-chat")).toHaveTextContent(ALICE);
    expect(url()).toBe(CHATS_PATH);
    expect(url()).not.toContain(ALICE);
  });
});
