/**
 * createOrg / acceptInvite / leaveOrg for an identity with MFA enrolled.
 *
 * auth-svc answers createOrg and acceptInvite with the same MfaPendingDTO that
 * /auth/login returns (the org/membership IS created; the challenge signs the
 * user into it), so both must parse either shape. leaveOrg takes an optional
 * step-up body, sent only when given.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import { isMfaPending } from "../types/domain";

const client = () => new ApiClient({ authBase: "http://auth.test", getToken: async () => "tok" } as never);

const SESSION = {
  accessToken: "access",
  expiresIn: 900,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    username: "sam",
    displayName: "Sam",
    email: "sam@example.com",
    roles: ["member"],
  },
};
const PENDING = { mfaRequired: true, pendingToken: "pend-1", methods: ["totp"], enrollmentRequired: false };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stubFetch = (res: () => Response) => {
  const fetchStub = vi.fn(async () => res());
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

afterEach(() => vi.unstubAllGlobals());

const CREATE = {
  orgName: "Acme",
  email: "sam@example.com",
  password: "correct-horse-9!",
  displayName: "Sam",
  captchaId: "cap",
  captchaValue: "abc",
};
const ACCEPT = { token: "inv", password: "correct-horse-9!", displayName: "Sam", username: "sam" };

describe.each([
  ["createOrg", "/auth/orgs", () => client().createOrg(CREATE)],
  ["acceptInvite", "/auth/invites/accept", () => client().acceptInvite(ACCEPT)],
])("%s", (_name, path, call) => {
  it("returns a session for an identity without MFA", async () => {
    const fetchStub = stubFetch(() => json(201, SESSION));

    const result = await call();

    expect(isMfaPending(result)).toBe(false);
    expect(result).toMatchObject({ accessToken: "access", user: { username: "sam" } });
    expect((fetchStub.mock.calls[0] as unknown as [string])[0]).toBe(`http://auth.test${path}`);
  });

  it("returns the MFA challenge, not a parse error, for an identity with MFA enrolled", async () => {
    stubFetch(() => json(201, PENDING));

    const result = await call();

    expect(isMfaPending(result)).toBe(true);
    expect(result).toMatchObject({ pendingToken: "pend-1", methods: ["totp"], enrollmentRequired: false });
  });
});

describe("leaveOrg", () => {
  const ORG = "33333333-3333-4333-8333-333333333333";

  it("sends no body when no step-up is given", async () => {
    const fetchStub = stubFetch(() => new Response(null, { status: 204 }));

    await expect(client().leaveOrg(ORG)).resolves.toBeUndefined();

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://auth.test/auth/orgs/${ORG}/leave`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("sends the step-up credential as a JSON body when given", async () => {
    const fetchStub = stubFetch(() => new Response(null, { status: 204 }));

    await client().leaveOrg(ORG, { password: "pw", totpCode: "123456" });

    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ password: "pw", totpCode: "123456" });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("surfaces 403 re-authentication required with its status and message", async () => {
    stubFetch(() => json(403, { error: { code: "forbidden", message: "re-authentication required" } }));

    const err = await client().leaveOrg(ORG).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, message: "re-authentication required" });
  });
});
