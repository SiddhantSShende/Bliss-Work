/**
 * Helpers for the New Meeting tests: a stand-in for the paged directory/channel endpoints
 * with the semantics the real ones have (search, then offset/limit over the matches), and
 * the user actions "add this person / this channel" through the Add section.
 */
import { screen, within } from "@testing-library/react";
import type { userEvent } from "@testing-library/user-event";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";
import { matchUser } from "../lib/matchUser";

type Page = { q?: string; offset?: number; limit?: number };

const slice = <T>(rows: T[], { offset = 0, limit }: Page) =>
  Promise.resolve(rows.slice(offset, limit == null ? undefined : offset + limit));

/** `api.directoryPage` over a fixed directory. */
export const directoryPageOf = (all: UserDTO[]) => (opts: Page = {}) =>
  slice(
    all.filter((u) => matchUser(u, opts.q ?? "")),
    opts,
  );

/** `api.channelsPage` over a fixed channel list. */
export const channelsPageOf = (all: ChannelDTO[]) => (opts: Page = {}) =>
  slice(
    all.filter((c) => c.name.toLowerCase().includes((opts.q ?? "").trim().toLowerCase())),
    opts,
  );

const pad = (n: number) => String(n).padStart(5, "0");

/** `n` distinct members, `user00001`… (ids and usernames sort in the same order). */
export function manyUsers(n: number, from: UserDTO): UserDTO[] {
  return Array.from({ length: n }, (_, i) => ({
    ...from,
    id: `00000000-0000-4000-8000-${String(10_000 + i).padStart(12, "0")}`,
    username: `user${pad(i + 1)}`,
    displayName: `Member ${pad(i + 1)}`,
    email: `user${pad(i + 1)}@acme.test`,
  }));
}

/** `n` distinct channels, `chan-00001`…. */
export function manyChannels(n: number, from: ChannelDTO): ChannelDTO[] {
  return Array.from({ length: n }, (_, i) => ({
    ...from,
    id: `00000000-0000-4000-8000-${String(20_000 + i).padStart(12, "0")}`,
    name: `chan-${pad(i + 1)}`,
    memberCount: 3,
  }));
}

type User = ReturnType<typeof userEvent.setup>;

export const peopleList = () => screen.getByRole("region", { name: "People" });
export const channelsList = () => screen.getByRole("region", { name: "Channels" });

/** Add a member on the (default) People tab. */
export async function addPerson(user: User, name: RegExp) {
  await user.click(await within(peopleList()).findByRole("button", { name }));
}

/** Switch to the Channels tab and add a channel. */
export async function addChannel(user: User, name: RegExp) {
  await user.click(screen.getByRole("tab", { name: /^Channels/ }));
  await user.click(await within(channelsList()).findByRole("button", { name }));
}
