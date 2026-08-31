import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "./client";

/**
 * Exercises the REAL upload path.
 *
 * uploadAttachment deliberately bypasses `req()` — it needs XMLHttpRequest for
 * upload progress and must let the browser set the multipart content-type — so
 * none of the coverage on `req()` applies to it. Production metrics showed the
 * upload request was never even issued while every other messaging call worked,
 * which is exactly the gap this closes.
 */

class FakeXHR {
  static instances: FakeXHR[] = [];
  method = "";
  url = "";
  withCredentials = false;
  headers: Record<string, string> = {};
  body: unknown;
  status = 201;
  responseText = "";
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  send(body: unknown) {
    this.body = body;
    // Does NOT complete on its own: each test drives the outcome explicitly via
    // respond()/onerror, so there is no race between the response being staged
    // and the handler firing.
  }
  /** Complete the request with a status and body. */
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
  abort() {
    this.onabort?.();
  }
}

const DTO = {
  id: "018f0000-0000-7000-8000-0000000000aa",
  scope: "thread",
  scopeId: "018f0000-0000-7000-8000-000000000001",
  role: "file",
  sha256: "a".repeat(64),
  mime: "application/pdf",
  sizeBytes: 3,
  filename: "notes.pdf",
  createdAt: "2026-08-07T00:00:00.000Z",
};

function makeClient(getToken = () => "tok") {
  return new ApiClient({
    authBase: "https://api.test/auth",
    taskBase: "https://api.test/tasks",
    notificationBase: "https://api.test/notifications",
    messagingBase: "https://api.test/messaging",
    wsUrl: "wss://api.test/ws",
    getToken,
  } as never);
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});
afterEach(() => vi.unstubAllGlobals());

describe("uploadAttachment", () => {
  it("issues a POST to the attachments endpoint with scope in the query string", async () => {
    const api = makeClient();
    const p = api.uploadAttachment(
      "thread",
      "018f0000-0000-7000-8000-000000000001",
      new Blob(["abc"]),
      { filename: "notes.pdf" },
    );
    // Let the constructor run before we inspect it.
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    const xhr = FakeXHR.instances[0]!;
    xhr.respond(201, DTO);

    await expect(p).resolves.toMatchObject({ id: DTO.id });

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain("https://api.test/messaging/api/v1/attachments");
    expect(xhr.url).toContain("scope=thread");
    expect(xhr.url).toContain("scopeId=018f0000-0000-7000-8000-000000000001");
    expect(xhr.headers["authorization"]).toBe("Bearer tok");
    // The browser MUST set content-type so it can add the multipart boundary.
    expect(xhr.headers["content-type"]).toBeUndefined();
    expect(xhr.body).toBeInstanceOf(FormData);
  });

  it("surfaces a server error instead of resolving", async () => {
    const api = makeClient();
    const p = api.uploadAttachment("thread", "t", new Blob(["x"]), { filename: "f" });
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    const xhr = FakeXHR.instances[0]!;
    xhr.respond(413, {
      error: { code: "payload_too_large", message: "file exceeds the maximum upload size" },
    });
    await expect(p).rejects.toThrow(/exceeds the maximum upload size/);
  });

  it("rejects on a network failure rather than hanging", async () => {
    const api = makeClient();
    const p = api.uploadAttachment("thread", "t", new Blob(["x"]), { filename: "f" });
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    const xhr = FakeXHR.instances[0]!;
    xhr.onerror?.();
    await expect(p).rejects.toThrow();
  });

  it("reports upload progress", async () => {
    const api = makeClient();
    const onProgress = vi.fn();
    const p = api.uploadAttachment("thread", "t", new Blob(["x"]), {
      filename: "f",
      onProgress,
    });
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    const xhr = FakeXHR.instances[0]!;
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    expect(onProgress).toHaveBeenCalledWith(5, 10);
    xhr.respond(201, DTO);
    await p;
  });
});
