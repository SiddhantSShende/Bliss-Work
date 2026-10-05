/**
 * The i18n calls go to auth-svc's own /i18n routes through the edge's /api/auth
 * mount. A browser console line "GET /api/auth/i18n/languages 404" is therefore NOT
 * a wrong URL: Caddy's handle_path strips /api/auth and auth-svc serves
 * /i18n/languages (routes/i18n_service.py, APIRouter prefix "/i18n"). It means the
 * deployed auth-svc build predates that router — scripts/verify-edge-routes.sh
 * tells the two apart on a live edge.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

const edge = () => new ApiClient({ authBase: "/api/auth", getToken: async () => "tok" } as never);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("i18n requests", () => {
  it("GETs /api/auth/i18n/languages (stripped to /i18n/languages by the edge) with the bearer token", async () => {
    const fetchStub = vi.fn(async () => json(200, { languages: [{ code: "es", name: "Spanish" }] }));
    vi.stubGlobal("fetch", fetchStub);

    await expect(edge().i18nLanguages()).resolves.toEqual({ languages: [{ code: "es", name: "Spanish" }] });

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/i18n/languages");
    expect(url.replace(/^\/api\/auth/, "")).toBe("/i18n/languages");
    expect(init.method ?? "GET").toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("accepts the empty list auth-svc answers when no translation key is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { languages: [] })));
    await expect(edge().i18nLanguages()).resolves.toEqual({ languages: [] });
  });

  it("GETs /api/auth/i18n/catalog?locale=… for a catalog", async () => {
    const fetchStub = vi.fn(async () => json(200, { locale: "es", namespaces: { common: { a: "b" } }, partial: false }));
    vi.stubGlobal("fetch", fetchStub);

    await edge().i18nCatalog("es");

    expect((fetchStub.mock.calls[0] as unknown as [string])[0]).toBe("/api/auth/i18n/catalog?locale=es");
  });

  it("reports an auth-svc build without the router (FastAPI's bare 404) as a 404 — never an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { detail: "Not Found" })));

    const err = await edge().i18nLanguages().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404 });
  });
});
