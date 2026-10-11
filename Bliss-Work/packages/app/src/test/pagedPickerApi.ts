/**
 * Test doubles for the paged pickers (New Task → Assign to).
 *
 * `pagedDirectory` and `pagedChannels` behave like the real endpoints where it
 * matters: `q` is a case-insensitive substring over the same fields the servers
 * search, `offset` counts rows of THAT search, a short page is the end. They record
 * every request, so a test can assert exactly how many pages were asked for.
 *
 * jsdom has no layout engine, so `stubScrollGeometry` gives a list's scroller a
 * height that follows its rows (40px each) in a 300px window, and a scrollTop that
 * a test can set. Without it every list reads as "near the bottom" and loads all
 * its pages at once.
 */
import { vi } from "vitest";
import { UserDTO, ChannelDTO } from "@taskboard/shared";

const id = (prefix: number, n: number) => `00000000-0000-4000-${String(prefix).padStart(4, "0")}-${String(n).padStart(12, "0")}`;

export function makeUsers(count: number, from = 0): UserDTO[] {
  return Array.from({ length: count }, (_, k) => {
    const n = from + k;
    const username = `person${String(n).padStart(3, "0")}`;
    return UserDTO.parse({
      id: id(1, n),
      orgId: id(9, 1),
      orgName: "Acme",
      username,
      displayName: `Person ${String(n).padStart(3, "0")}`,
      email: `${username}@acme.test`,
      roles: ["member"],
      avatarUrl: null,
      mfaEnrolled: false,
      orgRequireMfaForAdmins: false,
      orgMfaGracePeriodEndsAt: null,
      themePrefs: null,
    });
  });
}

export function makeChannels(count: number, from = 0): ChannelDTO[] {
  return Array.from({ length: count }, (_, k) => {
    const n = from + k;
    return ChannelDTO.parse({
      id: id(2, n),
      name: `team-${String(n).padStart(3, "0")}`,
      memberCount: n + 1,
      lastMessage: null,
      lastMessageAt: null,
      isLocked: n % 7 === 0,
      iAmMember: true,
    });
  });
}

type Page = { q?: string; limit?: number; offset?: number };

export function pagedDirectory(all: UserDTO[]) {
  return vi.fn(async ({ q = "", limit = 50, offset = 0 }: Page = {}) => {
    const needle = q.trim().toLowerCase();
    const hits = all.filter(
      (u) => !needle || [u.displayName, u.username, u.email].some((f) => f.toLowerCase().includes(needle)),
    );
    return hits.slice(offset, offset + limit);
  });
}

export function pagedChannels(all: ChannelDTO[]) {
  return vi.fn(async ({ q = "", limit = 50, offset = 0 }: Page = {}) => {
    const needle = q.trim().toLowerCase();
    return all.filter((c) => !needle || c.name.toLowerCase().includes(needle)).slice(offset, offset + limit);
  });
}

const ROW_PX = 40;
const WINDOW_PX = 300;

/** Install once per file (in beforeAll/beforeEach); undo with the returned function. */
export function stubScrollGeometry() {
  const tops = new WeakMap<Element, number>();
  const isScroller = (el: Element) => el.hasAttribute("aria-busy");
  const rows = (el: Element) => el.querySelectorAll(":scope > ul > li").length;
  const proto = HTMLElement.prototype;
  const saved = ["scrollHeight", "clientHeight", "scrollTop"].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k) ?? Object.getOwnPropertyDescriptor(Element.prototype, k)] as const);
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return isScroller(this) ? rows(this) * ROW_PX : 0; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return isScroller(this) ? WINDOW_PX : 0; } });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() { return tops.get(this) ?? 0; },
    set(v: number) { tops.set(this, v); },
  });
  return () => {
    for (const [k, d] of saved) d ? Object.defineProperty(proto, k, d) : delete (proto as unknown as Record<string, unknown>)[k];
  };
}

/** Scroll `el` to its very end and fire the event a real scroll would. */
export function scrollToEnd(el: HTMLElement, fire: (el: HTMLElement) => void) {
  el.scrollTop = el.scrollHeight - el.clientHeight;
  fire(el);
}
