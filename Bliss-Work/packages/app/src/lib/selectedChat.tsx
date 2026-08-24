/**
 * Which conversation the chats section has open.
 *
 * ── Why this is not in the URL ──────────────────────────────────────────────
 * It used to be: `/app/chats/:conversationId`, which put a conversation's UUID
 * in the address bar, in browser history, in the referrer of anything the page
 * links out to, and in whatever proxy or analytics log sees the path. A chat id
 * identifies a private conversation between two named people, and none of those
 * places is a reasonable home for one.
 *
 * So the id lives HERE, in memory, and the visible URL stays `/app/chats`.
 *
 * ── What that costs, and what it does not ───────────────────────────────────
 * In-memory means a reload has no selection to restore — which is the intended
 * behaviour, not a gap: the alternative (sessionStorage, or React Router's
 * `location.state`, which the History API persists across reloads) would put
 * the id back into something durable and hand it to the next person to use the
 * browser. A reload therefore lands on the chat list, with the section, the
 * list, and every open query exactly as they were.
 *
 * The BACK BUTTON is preserved deliberately rather than as a side effect.
 * Opening a chat pushes one history entry — same path, no id — so Back pops it,
 * this provider notices the POP and clears the selection, and the user is back
 * at the list exactly as they were before. Switching between chats REPLACES
 * that entry instead of stacking one per chat, so Back is always one press from
 * the list rather than a walk through everything visited.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

/** The one path the chats section is ever at. */
export const CHATS_PATH = "/app/chats";

interface SelectedChat {
  /** The open conversation's id, or null for "none — show the list". */
  selectedId: string | null;
  /**
   * Open a conversation and put the section on screen.
   *
   * `replace` is for callers that are already standing on a URL that should not
   * survive in history — the deep-link route, whose path carries the id this
   * whole module exists to keep out of the address bar.
   */
  openChat: (conversationId: string, options?: { replace?: boolean }) => void;
  /** Close the open conversation, leaving the section on the list. */
  closeChat: () => void;
}

const SelectedChatContext = createContext<SelectedChat | null>(null);

export function SelectedChatProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const loc = useLocation();
  const navType = useNavigationType();

  // Read by openChat, which must not be rebuilt every time the selection or the
  // location changes: it is handed to a list of chat rows as an onClick, and a
  // new identity on every render would re-render all of them on every keystroke
  // elsewhere in the shell.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const pathRef = useRef(loc.pathname);
  pathRef.current = loc.pathname;

  /**
   * A backwards navigation closes whatever was open.
   *
   * This is what makes Back mean "return to the list" now that leaving a chat
   * is no longer a change of URL. Keyed on `location.key` rather than on the
   * pathname, because the entry Back pops has the SAME path as the one it
   * pops from — the key is the only thing that distinguishes them.
   *
   * ── Why the first run has to be skipped ─────────────────────────────────
   * The initial load is itself reported as a POP, and effects run CHILD-FIRST:
   * on the deep-link route the child had already recorded its selection by the
   * time this ran, so an unguarded version wiped it and `/app/chats/:id` opened
   * the empty state instead of the conversation it named. Comparing keys makes
   * this fire only on a real change of entry.
   */
  const lastKey = useRef(loc.key);
  useEffect(() => {
    if (loc.key === lastKey.current) return;
    lastKey.current = loc.key;
    if (navType === "POP") setSelectedId(null);
  }, [loc.key, navType]);

  const openChat = useCallback(
    (conversationId: string, options?: { replace?: boolean }) => {
      setSelectedId(conversationId);
      // Swapping which chat is open is not a new place to come back to — only
      // opening one from the list is. Without this every chat visited would
      // stack an entry and Back would replay the session one chat at a time.
      const swapping = pathRef.current === CHATS_PATH && selectedRef.current !== null;
      navigate(CHATS_PATH, { replace: options?.replace ?? swapping });
    },
    [navigate],
  );

  // State only, no history. The entry pushed when the chat was opened is left
  // where it is: consuming it with navigate(-1) would walk out of the app
  // entirely for anyone whose chat was opened by a deep link, which pushes
  // nothing. The cost is that one Back press after using the in-app back
  // control is absorbed closing an already-closed chat.
  const closeChat = useCallback(() => setSelectedId(null), []);

  return (
    <SelectedChatContext.Provider value={{ selectedId, openChat, closeChat }}>
      {children}
    </SelectedChatContext.Provider>
  );
}

export function useSelectedChat(): SelectedChat {
  const ctx = useContext(SelectedChatContext);
  if (!ctx) {
    throw new Error("useSelectedChat must be used inside <SelectedChatProvider>");
  }
  return ctx;
}
