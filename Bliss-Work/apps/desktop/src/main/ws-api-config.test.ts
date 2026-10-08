import { ApiClient } from "@taskboard/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_ENDPOINTS, PROD_ENDPOINTS, resolveEndpoints } from "../shared/endpoints";
import { buildApiConfig } from "./ws-api-config";

const auth = { getToken: () => "tok", refreshToken: async () => null };

afterEach(() => vi.unstubAllGlobals());

describe("buildApiConfig (the ws-process ApiClient config)", () => {
  it.each([
    ["dev", DEV_ENDPOINTS],
    ["prod", PROD_ENDPOINTS],
    ["a TB_STICKY_BASE override", resolveEndpoints(false, { stickyBase: "http://sticky.example:9" })],
  ])("passes stickyBase through for %s endpoints", (_n, endpoints) => {
    expect(buildApiConfig(endpoints, auth).stickyBase).toBe(endpoints.stickyBase);
    expect(endpoints.stickyBase).toBeTruthy();
  });

  it("passes every service base through and derives presenceBase from wsUrl", () => {
    const c = buildApiConfig(PROD_ENDPOINTS, auth);
    expect(c).toMatchObject({
      authBase: PROD_ENDPOINTS.authBase,
      taskBase: PROD_ENDPOINTS.taskBase,
      messagingBase: PROD_ENDPOINTS.messagingBase,
      telemetryBase: PROD_ENDPOINTS.telemetryBase,
      notificationBase: PROD_ENDPOINTS.notificationBase,
      presenceBase: "https://communication.rnrtechs.com",
    });
  });

  it("yields a client whose sticky calls reach sticky-svc instead of the not-configured path", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(
        init?.method === "PUT"
          ? JSON.stringify({ taskId: "t1", state: "PINNED", updatedAt: "2026-01-01T00:00:00Z" })
          : init?.method === "POST"
            ? "{}"
            : "[]",
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient(buildApiConfig(DEV_ENDPOINTS, auth));

    expect(await api.stickyPinStates()).toEqual({ pinned: [], unpinned: [] });
    await expect(api.stickyPin("t1")).resolves.toBeDefined();
    await api.stickyAckDelivery("t1");

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls.length).toBe(3);
    for (const u of urls) expect(u.startsWith(`${DEV_ENDPOINTS.stickyBase}/api/v1/sticky/pins`)).toBe(true);
  });
});
