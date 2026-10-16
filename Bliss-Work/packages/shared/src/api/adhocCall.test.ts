/**
 * Ad-hoc calls on the wire: what makes a call ad-hoc, the request that starts a
 * conference, the event that rings one, and the limit the server enforces.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CallDTO, MAX_ADHOC_CALL_PARTICIPANTS, isAdhocCall } from "../types/domain";
import { EventType, ServerEvent } from "../types/events";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const CALL = "44444444-4444-4444-8444-444444444444";

afterEach(() => vi.unstubAllGlobals());

describe("isAdhocCall", () => {
  it("is a DIRECT call with no schedule", () => {
    expect(isAdhocCall({ kind: "DIRECT" })).toBe(true);
    expect(isAdhocCall({ kind: "DIRECT", scheduledAt: undefined })).toBe(true);
    expect(isAdhocCall({ kind: "DIRECT", scheduledAt: null })).toBe(true);
  });

  it("is not a DIRECT call that was scheduled, nor a meeting, nor a channel call", () => {
    expect(isAdhocCall({ kind: "DIRECT", scheduledAt: "2031-03-14T09:30:00.000Z" })).toBe(false);
    expect(isAdhocCall({ kind: "MEETING" })).toBe(false);
    expect(isAdhocCall({ kind: "CHANNEL" })).toBe(false);
  });
});

describe("startConferenceCall", () => {
  it("posts ONE request naming every person, and returns the call", async () => {
    const call = {
      id: CALL, orgId: A, kind: "DIRECT", title: "", media: "audio", createdBy: A,
      status: "LIVE", createdAt: "2026-10-10T10:00:00.000Z", participants: [], activeShares: [], channelIds: [],
    };
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(call), { status: 201, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ messagingBase: "http://msg.test", getToken: async () => "t" } as never);

    const got = await client.startConferenceCall([B, C], "audio");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://msg.test/api/v1/calls/direct");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ peerIds: [B, C], media: "audio" });
    expect(got.id).toBe(CALL);
    expect(isAdhocCall(CallDTO.parse(call))).toBe(true);
  });
});

describe("the ring", () => {
  it("carries who added you, so it can be read out", () => {
    const parsed = ServerEvent.safeParse({
      type: EventType.CallRing,
      eventId: "55555555-5555-4555-8555-555555555555",
      orgId: A,
      occurredAt: "2026-10-10T10:00:00.000Z",
      callId: CALL,
      kind: "DIRECT",
      actorId: B,
      actorName: "Jordan Doe",
      members: [C],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "actorName" in parsed.data && parsed.data.actorName).toBe("Jordan Doe");
  });
});

describe("the participant limit", () => {
  it("is the one messaging-svc enforces", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../../services/messaging-svc/internal/store/calls_adhoc.go", import.meta.url)),
      "utf8",
    );
    const server = /MaxAdhocCallParticipants\s*=\s*(\d+)/.exec(src)?.[1];
    expect(Number(server)).toBe(MAX_ADHOC_CALL_PARTICIPANTS);
  });
});

describe("declineCall", () => {
  it("POSTs to the decline endpoint with no body and expects no response body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ messagingBase: "http://msg.test", getToken: async () => "t" } as never);

    await client.declineCall(CALL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://msg.test/api/v1/calls/${CALL}/decline`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("the /calls/direct wire contract", () => {
  // A backend built before `peerIds` was added silently drops the unknown
  // JSON field (Go's decoder ignores keys it doesn't recognize) and falls
  // through to the single-peer branch with `peerId` empty, which fails
  // validUUID("") and returns 400 "invalid peerId" — exactly the production
  // symptom of a frontend shipped ahead of its backend. This guards against
  // that field ever being dropped from the request struct again.
  it("startDirectCall's request struct still decodes peerIds", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../../services/messaging-svc/internal/api/calls.go", import.meta.url)),
      "utf8",
    );
    const reqStruct = /type directCallReq struct \{[^}]*\}/.exec(src)?.[0];
    expect(reqStruct).toBeDefined();
    expect(reqStruct).toMatch(/PeerIDs\s+\[\]string\s+`json:"peerIds"`/);
  });
});
