/**
 * Resolving people to labels, on both transports — and the N+1 regression that
 * made this file necessary a second time.
 *
 * Passing `ids` is an OPTIMISATION and never a behaviour change: the same name
 * comes out either way and the same fallbacks apply. The catch is that the
 * lookup is cached by the id SET it was asked for, so a LIST whose rows each
 * compute their own set gets one request per row — the N+1 the gateway exists
 * to remove, reintroduced one layer up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const ADA = "018f0000-0000-7000-8000-0000000000a1";
const BO = "018f0000-0000-7000-8000-0000000000a2";

const person = (id: string, name: string) => ({
  id,
  orgId: "018f0000-0000-7000-8000-00000000000f",
  orgName: "Acme",
  username: name.toLowerCase(),
  displayName: name,
  email: `${name.toLowerCase()}@acme.test`,
  roles: ["member"],
  emailVerified: true,
  plan: "free",
});

const h = vi.hoisted(() => ({
  api: { directory: vi.fn(), graphql: vi.fn() },
  config: { kind: "web" } as { kind: string; graphBase?: string },
}));

vi.mock("./runtime", () => ({ useRuntime: () => ({ api: h.api, config: h.config }) }));

import { useUserLabels, usersByIdsQuery, displayNameOf } from "./userLabel";

const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
};
const renderLabels = (ids?: string[]) =>
  renderHook(() => useUserLabels(ids), { wrapper: wrapper() });

beforeEach(() => {
  vi.clearAllMocks();
  h.config = { kind: "web" };
  h.api.directory.mockResolvedValue([person(ADA, "Ada"), person(BO, "Bo")]);
  h.api.graphql.mockResolvedValue({ users: [person(ADA, "Ada")] });
});

describe("no gateway configured", () => {
  it("uses the directory when no ids are given", async () => {
    const { result } = renderLabels();
    await waitFor(() => expect(result.current.nameOf(ADA)).toBe("Ada"));
    expect(h.api.graphql).not.toHaveBeenCalled();
  });

  it("still uses the directory when ids ARE given", async () => {
    // Passing ids must not break a build with no gateway to ask.
    const { result } = renderLabels([ADA]);
    await waitFor(() => expect(result.current.nameOf(ADA)).toBe("Ada"));
    expect(h.api.directory).toHaveBeenCalled();
    expect(h.api.graphql).not.toHaveBeenCalled();
  });
});

describe("gateway configured", () => {
  beforeEach(() => {
    h.config = { kind: "web", graphBase: "http://graph.test" };
  });

  it("asks for exactly the people named, and NOT the directory", async () => {
    const { result } = renderLabels([ADA]);
    await waitFor(() => expect(result.current.nameOf(ADA)).toBe("Ada"));
    expect(h.api.graphql).toHaveBeenCalledWith("UsersByIds", { ids: [ADA] }, expect.anything());
    expect(h.api.directory).not.toHaveBeenCalled();
  });

  it("falls back to the directory when the caller cannot name the set", async () => {
    // A paginated feed whose rows arrive over a socket has no id list up front.
    const { result } = renderLabels();
    await waitFor(() => expect(result.current.nameOf(ADA)).toBe("Ada"));
    expect(h.api.directory).toHaveBeenCalled();
  });

  it("fetches nothing at all for an empty id list", async () => {
    renderLabels([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.api.graphql).not.toHaveBeenCalled();
    expect(h.api.directory).not.toHaveBeenCalled();
  });

  it("keeps the fallback for an id the gateway could not resolve", async () => {
    // Ids come from rows that outlive the accounts they reference.
    const { result } = renderLabels([ADA, BO]);
    await waitFor(() => expect(result.current.nameOf(ADA)).toBe("Ada"));
    expect(result.current.nameOf(BO, "bo.projected")).toBe("bo.projected");
  });

  it("still says Unknown user when there is no fallback either", async () => {
    const { result } = renderLabels([BO]);
    await waitFor(() => expect(h.api.graphql).toHaveBeenCalled());
    expect(result.current.nameOf(BO)).toBe("Unknown user");
  });

  it("resolves an address", async () => {
    const { result } = renderLabels([ADA]);
    await waitFor(() => expect(result.current.emailOf(ADA)).toBe("ada@acme.test"));
  });
});

describe("many rows on one screen", () => {
  beforeEach(() => {
    h.config = { kind: "web", graphBase: "http://graph.test" };
  });

  const renderMany = (idSets: string[][]) =>
    renderHook(() => idSets.map((ids) => useUserLabels(ids)), { wrapper: wrapper() });

  it("issues ONE request when every row is given the same id set", async () => {
    // The regression: twenty meeting cards each computing their own set meant
    // twenty calls to /auth/users. The list passes one shared set instead.
    const shared = [ADA, BO];
    renderMany([shared, shared, shared, shared, shared]);
    await waitFor(() => expect(h.api.graphql).toHaveBeenCalled());
    expect(h.api.graphql).toHaveBeenCalledTimes(1);
  });

  it("shares one request across equal-but-not-identical arrays", async () => {
    // Rows build their own array from the same data; the key is the CONTENT.
    renderMany([[ADA, BO], [ADA, BO], [ADA, BO]]);
    await waitFor(() => expect(h.api.graphql).toHaveBeenCalled());
    expect(h.api.graphql).toHaveBeenCalledTimes(1);
  });

  it("collapses sets that differ only in order", async () => {
    renderMany([[ADA, BO], [BO, ADA]]);
    await waitFor(() => expect(h.api.graphql).toHaveBeenCalled());
    expect(h.api.graphql).toHaveBeenCalledTimes(1);
  });

  it("DOES fan out when rows each ask for their own subset — the bug", async () => {
    // Executable statement of why the list passes one shared set down.
    renderMany([[ADA], [BO]]);
    await waitFor(() => expect(h.api.graphql).toHaveBeenCalledTimes(2));
  });
});

describe("usersByIdsQuery", () => {
  it("de-duplicates and sorts, so re-renders reuse one cache entry", () => {
    expect(usersByIdsQuery(h.api as never, [BO, ADA, BO]).queryKey).toEqual(
      usersByIdsQuery(h.api as never, [ADA, BO]).queryKey,
    );
  });

  it("drops empty ids rather than asking the gateway about them", async () => {
    await usersByIdsQuery(h.api as never, ["", ADA]).queryFn();
    expect(h.api.graphql).toHaveBeenCalledWith("UsersByIds", { ids: [ADA] }, expect.anything());
  });

  it("keys distinct id sets separately", () => {
    expect(usersByIdsQuery(h.api as never, [ADA]).queryKey).not.toEqual(
      usersByIdsQuery(h.api as never, [BO]).queryKey,
    );
  });
});

describe("displayNameOf", () => {
  it("prefers the display name over the derived username", () => {
    expect(displayNameOf({ peerDisplayName: "Ada L", peerUsername: "ada.l" })).toBe("Ada L");
  });

  it("falls back to the username, then to Unknown user", () => {
    expect(displayNameOf({ peerUsername: "ada.l" })).toBe("ada.l");
    expect(displayNameOf(null)).toBe("Unknown user");
  });
});
